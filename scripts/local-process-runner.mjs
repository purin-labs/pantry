import { spawn, spawnSync } from "node:child_process";

const PORT_TERMINATION_TIMEOUT_MS = 2_000;
const PORT_POLL_INTERVAL_MS = 50;
const PORT_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));

export function clearLocalPorts(ports) {
  const listeners = new Set();
  for (const port of ports) {
    for (const pid of portListeners(port)) {
      listeners.add(pid);
    }
  }

  for (const pid of listeners) {
    signalListener(pid, "SIGTERM");
  }

  let occupied = waitForPortsToClear(ports);
  if (occupied.length > 0) {
    signalPortListeners(occupied, "SIGKILL");
    occupied = waitForPortsToClear(ports);
  }

  if (occupied.length > 0) {
    throw new Error(`Could not clear local ports: ${occupied.join(", ")}`);
  }

  if (listeners.size > 0) {
    console.log(
      `Stopped existing listeners on local ports ${ports.join(", ")}.`,
    );
  }
}

function waitForPortsToClear(ports) {
  const deadline = Date.now() + PORT_TERMINATION_TIMEOUT_MS;
  let occupied = occupiedPorts(ports);

  while (occupied.length > 0 && Date.now() < deadline) {
    Atomics.wait(PORT_WAIT_STATE, 0, 0, PORT_POLL_INTERVAL_MS);
    occupied = occupiedPorts(ports);
  }

  return occupied;
}

function signalPortListeners(ports, signal) {
  for (const port of ports) {
    for (const pid of portListeners(port)) {
      signalListener(pid, signal);
    }
  }
}

function occupiedPorts(ports) {
  return ports.filter(portIsOccupied);
}

function portIsOccupied(port) {
  return portListeners(port).length > 0;
}

function portListeners(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (
    result.status === 1 &&
    result.stdout.trim() === "" &&
    result.stderr.trim() === ""
  ) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect local port ${port}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim().split(/\s+/u).map(Number);
}

function signalListener(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    )) {
      throw error;
    }
  }
}

class ServiceLogWriter {
  constructor(specification, destination, onLine) {
    this.buffer = "";
    this.destination = destination;
    this.header = createServiceHeader(specification, destination);
    this.onLine = onLine;
  }

  write(chunk) {
    const lines = `${this.buffer}${chunk}`.split(/\r\n|\r|\n/u);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.writeLine(line);
    }
  }

  flush() {
    if (this.buffer.length === 0) {
      return;
    }
    this.writeLine(this.buffer);
    this.buffer = "";
  }

  writeLine(line) {
    this.onLine(line);
    this.destination.write(`${this.header} | ${line}\n`);
  }
}

export function runLocalProcesses(root, commands, groupName) {
  const state = {
    children: [],
    groupName,
    readiness: createReadiness(commands),
    stopping: false,
  };
  state.children = commands.map(startCommand.bind(null, state, root));
  process.once("SIGINT", stopForInterrupt.bind(null, state));
  process.once("SIGTERM", stopForTermination.bind(null, state));
  return { ready: state.readiness.promise };
}

function startCommand(state, root, specification) {
  const child = spawn(specification.command, specification.args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const observeLine = observeServiceLine.bind(null, state, specification);
  const output = new ServiceLogWriter(
    specification,
    process.stdout,
    observeLine,
  );
  const errors = new ServiceLogWriter(
    specification,
    process.stderr,
    observeLine,
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", output.write.bind(output));
  child.stderr.on("data", errors.write.bind(errors));
  child.once("error", handleChildError.bind(null, state, specification.name));
  child.once(
    "close",
    handleChildClose.bind(null, state, specification, output, errors),
  );
  return child;
}

function handleChildError(state, name, error) {
  const message = `${name} failed to start: ${error.message}`;
  console.error(message);
  rejectReadiness(state.readiness, message);
  stopLocalProcesses(state, 1);
}

function handleChildClose(state, specification, output, errors, code, signal) {
  output.flush();
  errors.flush();
  if (state.stopping) {
    return;
  }
  if (specification.lifecycle === "setup" && code === 0) {
    markCommandReady(state, specification.name);
    return;
  }
  const reason = signal === null ? `status ${code ?? 1}` : `signal ${signal}`;
  const message = `${specification.name} stopped with ${reason}; stopping local ${state.groupName}.`;
  console.error(message);
  rejectReadiness(state.readiness, message);
  stopLocalProcesses(state, code ?? 1);
}

function observeServiceLine(state, specification, line) {
  if (
    specification.readyPattern instanceof RegExp &&
    specification.readyPattern.test(line)
  ) {
    markCommandReady(state, specification.name);
  }
}

function createReadiness(commands) {
  const readiness = {
    pending: new Set(
      commands.filter(commandRequiresReadiness).map(commandName),
    ),
    promise: undefined,
    reject: undefined,
    resolve: undefined,
    settled: false,
  };
  readiness.promise = new Promise(
    registerReadinessResolver.bind(null, readiness),
  );
  completeReadinessIfSatisfied(readiness);
  return readiness;
}

function commandRequiresReadiness(specification) {
  return (
    specification.lifecycle === "setup" ||
    specification.readyPattern instanceof RegExp
  );
}

function commandName(specification) {
  return specification.name;
}

function registerReadinessResolver(readiness, resolve, reject) {
  readiness.resolve = resolve;
  readiness.reject = reject;
}

function markCommandReady(state, name) {
  state.readiness.pending.delete(name);
  completeReadinessIfSatisfied(state.readiness);
}

function completeReadinessIfSatisfied(readiness) {
  if (
    readiness.pending.size !== 0 ||
    readiness.resolve === undefined ||
    readiness.settled
  ) {
    return;
  }
  readiness.settled = true;
  readiness.resolve();
}

function rejectReadiness(readiness, message) {
  if (readiness.reject === undefined || readiness.settled) {
    return;
  }
  readiness.settled = true;
  readiness.reject(new Error(message));
}

function stopForInterrupt(state) {
  stopLocalProcesses(state, 130);
}

function stopForTermination(state) {
  stopLocalProcesses(state, 143);
}

function stopLocalProcesses(state, exitCode) {
  if (state.stopping) {
    return;
  }
  state.stopping = true;
  for (const child of state.children) {
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child);
    }
  }
  process.exitCode = exitCode;
}

function terminateProcessTree(child) {
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    )) {
      throw error;
    }
  }
}

function createServiceHeader(specification, destination) {
  const label = specification.name.padEnd(14);
  if (destination.isTTY !== true || process.env.NO_COLOR !== undefined) {
    return label;
  }
  return `\u001b[${specification.headerColor}m${label}\u001b[0m`;
}
