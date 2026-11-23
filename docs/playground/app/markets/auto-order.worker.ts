import { collectAutoOrderPrices, type AutoOrderTick } from "../../lib/auto-order";

const observe = collectAutoOrderPrices((quote) => self.postMessage(quote));
self.addEventListener("message", (event: MessageEvent<AutoOrderTick>) => observe(event.data));
