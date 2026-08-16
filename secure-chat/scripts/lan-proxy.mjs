/**
 * 집 LAN에서만 맥 loopback 서버로 넘긴다.
 * 서버 자체는 127.0.0.1에 두고, 아이폰은 192.168.50.235로 붙는다.
 */
import net from "node:net";

const BIND = process.env.LOCAL_AI_LAN_BIND ?? "192.168.50.235";
const UPSTREAM = "127.0.0.1";

if (!/^192\.168\.\d{1,3}\.\d{1,3}$/.test(BIND)) {
  console.error("LOCAL_AI_LAN_BIND는 집 LAN IPv4만 허용합니다.");
  process.exit(1);
}

function proxy(name, listenPort, targetPort) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: UPSTREAM, port: targetPort });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  server.on("error", (error) => {
    console.error(`lan-proxy ${name} 오류: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, BIND, () => {
    console.log(`lan-proxy ${name}: ${BIND}:${listenPort} → ${UPSTREAM}:${targetPort}`);
  });
}

proxy("secure-chat", 18791, 18791);
proxy("open-webui", 3000, 3000);
