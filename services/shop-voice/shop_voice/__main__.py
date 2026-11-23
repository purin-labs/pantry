"""The commands of the shop Mac service. install.sh runs `enroll` and `start`; launchd runs `run`."""
import argparse
import dataclasses
import os
import shlex
import shutil
import socket
import subprocess
import threading
import time

import certifi

from . import VERSION, certificate, launchd, platform_api, state
from .engine_choice import EngineChoice
from .engines import DEFAULT_ENGINE, ENGINES, new_engine
from .model_files import ModelFiles
from .model_host import ModelHost
from .server import ShopVoice, serve
from .speech import ANSWER_SLOTS, QUEUE_WAIT_SECONDS, VOICE_FILES, AnswerVoice

# One command that runs and two that wait.
COMMAND_SLOTS = 3
# The Portal stops waiting after 5.5 s for the longest command, so an older command has no reader.
COMMAND_QUEUE_WAIT_SECONDS = 6.0

VOCABULARY_SECONDS = 5 * 60
# One refusal stops the service from answering. The files go only after a refusal that stays,
# because a mistake in a Platform release must not cost a shop a new enrollment and a new download.
REFUSALS_BEFORE_WIPE = 5


def private_address() -> str | None:
    """The address on the route to the internet. This sends no packet."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("1.1.1.1", 53))
        except OSError:
            return None
        return probe.getsockname()[0]


def run_service() -> int:
    config = state.load_config()
    if config is None:
        print("This Mac is not enrolled.", flush=True)
        return 0
    # This keeps the Mac awake for as long as the service runs.
    subprocess.Popen(["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())])
    # A Mac from before 0.4.0 kept Whisper's files in the models' folder itself.
    whisper = ENGINES[DEFAULT_ENGINE]
    state.adopt_loose_model_files(whisper.id, [name for name, _, _ in whisper.files.files])
    engine = new_engine(state.active_engine(DEFAULT_ENGINE, set(ENGINES)))
    state.mark_engine_used(engine.id)
    files = ModelFiles(state.engine_dir(engine.id), engine.files, config.model_base_url)
    transcription = ModelHost(engine, files, config.idle_unload_seconds, label="Speech engine",
                              slots=COMMAND_SLOTS, queue_wait_seconds=COMMAND_QUEUE_WAIT_SECONDS)
    choice = EngineChoice(transcription, config.model_base_url)
    speech_files = ModelFiles(state.speech_dir(), VOICE_FILES, config.speech_base_url)
    speech = ModelHost(AnswerVoice(), speech_files, config.idle_unload_seconds, label="Answer voice",
                       slots=ANSWER_SLOTS, queue_wait_seconds=QUEUE_WAIT_SECONDS)
    shop = ShopVoice(config, transcription, speech)
    tls = certificate.Certificate(config)
    files.start()
    speech_files.start()
    tls.start()
    threading.Thread(target=serve, args=(shop, tls), name="server", daemon=True).start()
    print(f"Purin Pantry shop voice {VERSION} runs as {config.hostname}.", flush=True)

    refusals = 0
    next_vocabulary = 0.0
    last_problem = None
    while True:
        address = private_address()
        try:
            if address is None:
                raise OSError("no network")
            answer = platform_api.heartbeat(config.platform_origin, config.credential, address,
                                            transcription.model_state, shop.engine_id, list(ENGINES))
            choice.follow(answer.get("engineChoice"))
            refusals = 0
            shop.refusing = False
            if time.monotonic() >= next_vocabulary:
                shop.vocabulary = tuple(platform_api.vocabulary(config.platform_origin, config.credential))
                next_vocabulary = time.monotonic() + VOCABULARY_SECONDS
            last_problem = None
        except platform_api.PlatformRefused as refused:
            if refused.status == 401:
                refusals += 1
                shop.refusing = True
                if refusals >= REFUSALS_BEFORE_WIPE:
                    state.wipe_enrollment()
                    print("The Platform revoked this Mac. The model, certificate and credential are deleted.", flush=True)
                    return 0
            elif str(refused) != last_problem:
                last_problem = str(refused)
                print(f"Platform refused: {refused}", flush=True)
        except OSError as error:
            if str(error) != last_problem:
                last_problem = str(error)
                print(f"Platform unreachable: {error}", flush=True)
        except platform_api.PlatformAnswerInvalid as error:
            # A heartbeat that the service cannot read is not an accepted one: the refusals stay.
            if str(error) != last_problem:
                last_problem = str(error)
                print(f"Platform answer unreadable: {error}", flush=True)
        transcription.unload_if_idle()
        speech.unload_if_idle()
        choice.remove_unused()
        time.sleep(config.heartbeat_seconds)


def enroll(args: argparse.Namespace) -> None:
    if not args.accept_letsencrypt_terms:
        raise SystemExit("Pass --accept-letsencrypt-terms to accept the Let's Encrypt subscriber agreement.")
    origin = args.origin.rstrip("/")
    try:
        enrolled = platform_api.enroll(origin, args.organisation, args.mac, args.code)
    except platform_api.PlatformRefused as refused:
        raise SystemExit(f"The Platform refused this enrollment: {refused}. Start a new enrollment in the Portal.") from None
    config = state.Config(platform_origin=origin, organisation_id=args.organisation, mac_id=args.mac,
                          credential=enrolled["credential"], grant_key=enrolled["grantKey"], hostname=enrolled["hostname"],
                          portal_origins=args.portal_origin or [origin], port=args.port)
    if args.journey_heartbeat_seconds:
        config = dataclasses.replace(config, heartbeat_seconds=args.journey_heartbeat_seconds,
                                     idle_unload_seconds=args.journey_idle_unload_seconds,
                                     model_base_url=args.journey_model_base_url, wait_for_dns=False,
                                     certificate_command=shlex.split(args.journey_certificate_command))
    state.save_config(config)
    print(f"Enrolled as {config.hostname}.")


def status() -> None:
    config = state.load_config()
    print(f"Version: {VERSION}")
    print(f"Enrolled: {config.hostname if config else 'no'}")
    if config is None:
        return
    print(f"Private address: {private_address()}")
    chain, _ = certificate.live_files(config.hostname)
    print(f"Certificate: {'present' if chain.exists() else 'not yet'}")
    engine = new_engine(state.active_engine(DEFAULT_ENGINE, set(ENGINES)))
    present = ModelFiles(state.engine_dir(engine.id), engine.files).complete()
    print(f"Speech engine: {engine.id}, files {'present' if present else 'not yet'}")
    others = [engine_id for engine_id in state.kept_engine_files() if engine_id != engine.id]
    print(f"Other engine files: {', '.join(others) if others else 'none'}")
    voice_present = ModelFiles(state.speech_dir(), VOICE_FILES).complete()
    print(f"Answer voice files: {'present' if voice_present else 'not yet'}")
    firewall = subprocess.run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"], capture_output=True, text=True)
    print(f"macOS firewall: {firewall.stdout.strip()}")
    print(f"Log: {state.home() / 'service.log'}")


def uninstall() -> None:
    launchd.remove()
    shutil.rmtree(state.home(), ignore_errors=True)
    print("Removed the service, the model, the certificate and the credential. Revoke this Mac in the Portal.")


def main() -> int:
    # The managed Python has no system certificates of its own.
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    parser = argparse.ArgumentParser(prog="shop_voice")
    commands = parser.add_subparsers(dest="command", required=True)
    enroller = commands.add_parser("enroll")
    enroller.add_argument("--origin", required=True)
    enroller.add_argument("--organisation", required=True)
    enroller.add_argument("--mac", required=True)
    enroller.add_argument("--code", required=True)
    enroller.add_argument("--accept-letsencrypt-terms", action="store_true")
    enroller.add_argument("--portal-origin", action="append")
    enroller.add_argument("--port", type=int, default=state.DEFAULT_PORT)
    enroller.add_argument("--journey-heartbeat-seconds", type=int, help=argparse.SUPPRESS)
    enroller.add_argument("--journey-idle-unload-seconds", type=int, help=argparse.SUPPRESS)
    enroller.add_argument("--journey-model-base-url", help=argparse.SUPPRESS)
    enroller.add_argument("--journey-certificate-command", help=argparse.SUPPRESS)
    commands.add_parser("start")
    commands.add_parser("run")
    commands.add_parser("status")
    commands.add_parser("uninstall")
    hook = commands.add_parser("certificate-hook")
    hook.add_argument("action", choices=("put", "delete"))
    args = parser.parse_args()
    if args.command == "enroll":
        enroll(args)
    elif args.command == "start":
        launchd.write_and_start()
    elif args.command == "run":
        return run_service()
    elif args.command == "status":
        status()
    elif args.command == "uninstall":
        uninstall()
    else:
        config = state.load_config()
        if config is None:
            raise SystemExit("This Mac is not enrolled.")
        certificate.run_hook(config, args.action)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
