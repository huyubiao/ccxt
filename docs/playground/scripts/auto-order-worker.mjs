import { parentPort } from "node:worker_threads";
import { collectAutoOrderPrices } from "../lib/auto-order.ts";

parentPort.on("message", collectAutoOrderPrices((quote) => parentPort.postMessage(quote)));
