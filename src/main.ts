import { compileMachine } from "./compiler/compiler.js";
import { TINY_APPROVAL_SOURCE } from "./examples/tinyApproval.js";

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  compileMachine(TINY_APPROVAL_SOURCE).then((compiled) => {
    app.textContent = `GateX Gate B checkpoint | ${compiled.nandCount} NAND | ${compiled.latchCount} LATCH | ${compiled.hash}`;
  });
}
