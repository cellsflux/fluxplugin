// Renderer entry. Order matters: styles → bootstrap (infrastructure) → mount (UI).
import "./styles/app.css";
import { createRoot } from "react-dom/client";
import { bootstrap } from "./bootstrap";
import { App } from "./App";

const { framework, bridge } = await bootstrap();
createRoot(document.getElementById("root")!).render(<App framework={framework} bridge={bridge} />);
