import { deploy } from "./deploy.ts";

const [command] = process.argv.slice(2);
switch (command) {
  case "deploy":
    await deploy();
    break;
  case "e2e":
    await import("./e2e.ts");
    break;
  case "pin":
    await import("./pin.ts");
    break;
  case "measure":
    await import("./measure.ts");
    break;
  default:
    console.error("usage: vajra deploy");
    process.exit(1);
}
