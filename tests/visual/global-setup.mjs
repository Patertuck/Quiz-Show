import { startStaticServer } from "./static-server.mjs";

export default async function globalSetup() {
  const server = await startStaticServer();
  return () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}
