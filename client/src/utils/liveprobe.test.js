// A one-off: the shipping reader, against the real lab switches.
import { vi, test } from 'vitest';
import dgram from 'node:dgram';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    query: ({ host, port, timeoutMs, data }) => new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        sock.close();
        reject(Object.assign(new Error('The switch did not answer in time.'), { code: 'timeout' }));
      }, timeoutMs);
      sock.on('message', (m, rinfo) => {
        clearTimeout(timer); sock.close();
        resolve({ data: Buffer.from(m).toString('base64'), bytes: m.length, from: rinfo.address });
      });
      sock.send(Buffer.from(data, 'base64'), port, host);
    }),
  }),
}));

const { readSwitch } = await import('./snmpClient');

const SW = [
  { label: 'Core switch', host: '192.168.1.100' },
  { label: 'Sw1', host: '192.168.1.11' },
  { label: 'Sw2', host: '192.168.1.12' },
];

// Hits the real lab switches. Off unless RT_LIVE=1 is set.
const live = process.env.RT_LIVE === '1' ? test : test.skip;
live('read the lab', async () => {
  for (const t of SW) {
    const cfg = { host: t.host, port: 161, version: 'v3', username: 'Sprintpark_AIML', securityLevel: 'noAuthNoPriv' };
    const t0 = Date.now();
    let firstPaint = null;
    try {
      const r = await readSwitch(cfg, () => {}, (partial) => {
        if (firstPaint === null) firstPaint = Date.now() - t0;
        if (partial.kind === 'full' && !partial.serial) console.log(`  ports painted at ${Date.now() - t0} ms`);
      });
      const ms = Date.now() - t0;
      console.log(`\n### ${t.label} ${t.host} — ${r.vendor} ${r.model || '(no model)'} — identity at ${firstPaint} ms, all in at ${ms} ms`);
      console.log(`  ports ${r.counts.ports}, up ${r.counts.up}, neighbours ${r.counts.neighbours}, attached ${r.counts.attached}`);
      console.log('  gaps:', r.gaps.join(' | ') || 'none');
      const p = r.interfaces.find((i) => i.up) || r.interfaces[0];
      if (p) console.log(`  a port: ${p.name} up=${p.up} ${p.speedMbps || '?'}Mb duplex=${p.duplex} mac=${p.mac} attached=${p.attached}`);
      for (const d of r.attached.slice(0, 6)) console.log(`  attached: ${d.mac} ${d.ip || '(no ip)'} on ${d.port} vlan ${d.vlan}`);
      for (const n of r.neighbours.slice(0, 5)) console.log(`  neighbour: ${n.sysName} named=${n.named} their ${n.port} on our ${n.localPort}`);
    } catch (e) {
      console.log(`\n### ${t.label} ${t.host} — FAILED after ${Date.now() - t0} ms: ${e.message}`);
    }
  }
}, 300000);
