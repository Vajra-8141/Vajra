import { deploy } from "./deploy.ts";

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "deploy":
    await deploy(argument);
    break;
  case "e2e":
    await import("./e2e.ts");
    break;
  case "budget":
    await import("./budget.ts");
    break;
  case "pin":
    await import("./pin.ts");
    break;
  case "measure":
    await import("./measure.ts");
    break;
  default:
    console.error("usage: vajra deploy|e2e|measure|pin|budget");
    process.exit(1);
}
