import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';

const loopback = '127.0.0.1';

/** Serve one password to the askpass child of the SSH process that owns this listener. */
export async function startAskpass(password) {
  const nonce = randomBytes(32).toString('hex');
  const secret = Buffer.from(password, 'utf8');
  password = undefined;
  const sockets = new Set();
  let expected;
  let closing;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      if (!expected || received.length + chunk.length > expected.length) return socket.destroy();
      received = Buffer.concat([received, chunk]);
      if (received.length !== expected.length) return;
      if (!timingSafeEqual(received, expected)) return socket.destroy();
      expected = undefined;
      socket.end(secret, () => {
        secret.fill(0);
        socket.destroy();
      });
    });
  });
  server.maxConnections = 8;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: loopback, port: 0, exclusive: true }, resolve);
    });
  } catch (error) {
    secret.fill(0);
    throw error;
  }
  return {
    env: { DSH_SSH_ASKPASS_PORT: String(server.address().port), DSH_SSH_ASKPASS_NONCE: nonce },
    allow(pid) {
      if (pid) expected = Buffer.from(`${nonce}:${pid}\n`);
    },
    close() {
      expected = undefined;
      for (const socket of sockets) socket.destroy();
      secret.fill(0);
      return closing ??= new Promise(resolve => server.close(resolve));
    },
  };
}
