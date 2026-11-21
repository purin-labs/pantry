# Repair access to a shop gateway

This runbook gives an engineer SSH access to a shop gateway (Plan 85, decision D4). It uses
Cloudflare Tunnel with Cloudflare Access. The gateway dials out, so the shop opens no port. The
Portal has no repair access, and Pantry's gateway credential takes no part.

Do this when the first real gateway goes into a shop. Do it again for each new gateway.

## Cost

- Cloudflare Tunnel has no charge.
- Cloudflare Access has no charge for a team of fewer than 50 users. Above that, the
  pay-as-you-go plan costs about $7 for each user in a month, paid each year. Check the price
  on Cloudflare's Zero Trust plans page before the 50th user.
- The setup takes about 30 minutes for each gateway. The first gateway also needs the Access
  application, about 15 minutes more.

## Before you start

- You need a Cloudflare account with a zone (a domain on Cloudflare) for the SSH hostname.
  This runbook writes `ssh-<gateway>.example.com`. Use your own zone.
- You need a person at the shop, or a screen and keyboard on the gateway, for the first steps.
- The gateway runs its SSH server only for keys. On Linux, set `PasswordAuthentication no` in
  `/etc/ssh/sshd_config`. On a Mac, turn on Remote Login in System Settings > General > Sharing,
  and give access only to the repair user.
- Use a repair user that is not `root`. The Pantry gateway credential file is readable only by
  the account that runs the gateway service.

## 1. Create the tunnel

1. In the Cloudflare dashboard, open Zero Trust > Networks > Tunnels.
2. Create a tunnel of the type Cloudflared. Name it after the gateway, for example
   `gw-main-shop-1`.
3. Copy the install command that the dashboard shows for the gateway's operating system.
   The command holds the tunnel token. The token is a secret: do not put it in git, a chat or a
   ticket.

## 2. Install cloudflared on the gateway

On Linux (Debian or Raspberry Pi OS), install the package from Cloudflare's package repository,
then run the dashboard command as root:

```bash
sudo cloudflared service install <tunnel-token>
```

On a Mac, install with Homebrew, then run the same command:

```bash
brew install cloudflared
```

```bash
sudo cloudflared service install <tunnel-token>
```

The dashboard shows the tunnel as Healthy within a minute. The service starts again after a
restart of the gateway.

## 3. Publish SSH through the tunnel

1. Open the tunnel, then its Routes tab (Public hostnames in older dashboards).
2. Add a published application. Give the hostname `ssh-<gateway>.example.com`.
3. Set the service type to SSH and the address to `localhost:22`.

## 4. Allow only named engineers

1. In Zero Trust > Access > Applications, add a self-hosted application for
   `ssh-<gateway>.example.com`. The first gateway can use a wildcard, `ssh-*.example.com`, so
   that later gateways need no new application.
2. Add one Allow policy with the email address of each engineer. Do not use a policy that allows a
   whole email domain.
3. Set the session duration to 8 hours or less.

## 5. Connect from an engineer's computer

1. Install `cloudflared` on the engineer's computer.
2. Add this block to `~/.ssh/config`. On a Mac with Homebrew, the path is
   `$(brew --prefix cloudflared)/bin/cloudflared`.

```text
Host ssh-*.example.com
  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h
```

3. Connect. A browser window opens for the Access sign-in, and then the SSH session starts.

```bash
ssh repair@ssh-<gateway>.example.com
```

## Check the gateway

These commands show the Pantry gateway service and its last messages on Linux:

```bash
systemctl status pantry-shop-gateway.service
```

```bash
journalctl -u pantry-shop-gateway.service --since "1 hour ago"
```

The Devices page stays the place for work state. Do not change a device's state from the shell.
The emergency stop stays on the machine.

## Remove access

- To remove one engineer, remove their address from the Access policy. Their open session ends
  when its duration ends.
- To remove the route, delete the published application from the tunnel. Then delete the tunnel,
  and on the gateway run `sudo cloudflared service uninstall`.
- If a repair user or a tunnel token may be known to a wrong person, delete the tunnel at once. Then
  revoke the gateway on the Devices page and enroll it again with a new code, because a shell on the
  gateway can read the gateway credential.

## Other choices

- Cloudflare also offers SSH with short-lived certificates (Access for Infrastructure). It needs
  the Cloudflare One client on each engineer's computer, and it adds command logs. Use it when more
  than a few engineers need access.
- Tailscale is the alternative if an engineer needs direct control of more than SSH.
