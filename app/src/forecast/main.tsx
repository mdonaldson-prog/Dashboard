import { render } from "preact";
import { ForecastApp } from "./ForecastApp";
import "../styles.css";
import "./forecast.css";

render(<ForecastApp />, document.getElementById("app")!);
