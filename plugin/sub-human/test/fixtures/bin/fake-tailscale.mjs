// The fake tailscale's body. FAKE_TS_LOG gets one JSON line of arguments per run; FAKE_TS_STATE holds the serve config
// as `tailscale serve status --json` prints it ({TCP, AllowFunnel}); FAKE_TS_BACKEND is the BackendState (Running);
// FAKE_TS_OFF makes funnel and serve print the enable URL and then wait, as the CLI does when the tailnet has it off.
import fs from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_TS_LOG) fs.appendFileSync(env.FAKE_TS_LOG, `${JSON.stringify(args)}\n`);
const DNS = 'node.tail1234.ts.net';
const read = () => { try { return JSON.parse(fs.readFileSync(env.FAKE_TS_STATE ?? '', 'utf8')); } catch { return {}; } };
const write = s => { fs.writeFileSync(env.FAKE_TS_STATE ?? '', JSON.stringify(s)); };

if (args[0] === 'status') {
  const backend = env.FAKE_TS_BACKEND ?? 'Running';
  process.stdout.write(JSON.stringify(backend === 'Running' ? { BackendState: backend, Self: { DNSName: `${DNS}.` } } : { BackendState: backend }));
} else if (args[0] === 'serve' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(read()));
} else if (args[0] === 'funnel' || args[0] === 'serve') {
  const port = /^--tls-terminated-tcp=(\d+)$/.exec(args.find(a => a.startsWith('--tls-terminated-tcp=')) ?? '')?.[1];
  const s = read();
  s.TCP ??= {};
  s.AllowFunnel ??= {};
  if (args.at(-1) === 'off') {
    delete s.TCP[port];
    delete s.AllowFunnel[`${DNS}:${port}`];
    write(s);
  } else if (env.FAKE_TS_OFF) {
    process.stdout.write(`${args[0] === 'funnel' ? 'Funnel' : 'Serve'} is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/${args[0]}?node=n1\n\n`);
    setInterval(() => {}, 1000);
  } else {
    s.TCP[port] = { TCPForward: args.at(-1)?.replace('tcp://', ''), TerminateTLS: DNS, ProxyProtocol: 2 };
    if (args[0] === 'funnel') s.AllowFunnel[`${DNS}:${port}`] = true;
    write(s);
    process.stdout.write('Available on the internet\n');
  }
} else {
  process.stderr.write(`fake tailscale: unknown command ${args.join(' ')}\n`);
  process.exit(1);
}
