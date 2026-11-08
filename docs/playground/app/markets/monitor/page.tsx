import { redirect } from "next/navigation";

export default function MonitorRedirect() {
  redirect("/markets#market-alerts");
}
