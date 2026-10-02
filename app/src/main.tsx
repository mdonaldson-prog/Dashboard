import { render } from "preact";
import demo from "virtual-demo";
import { App } from "./App";
import type { Dataset } from "./data/model";
import "./styles.css";

render(<App demo={(demo as Dataset | null) ?? null} />, document.getElementById("app")!);
