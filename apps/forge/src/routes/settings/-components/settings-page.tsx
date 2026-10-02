import { SectionHead } from "@gitflare/ui/components/row";
import { PageHead } from "@/components/shell/page";
import { Members } from "./members";
import { Spend } from "./spend";
import { Workspace } from "./workspace";

export function SettingsPage() {
  return (
    <>
      <PageHead
        title="Settings"
        lede="Who can do what in this deployment, what its agents have cost this month, and what every sandbox boots from."
      />
      <SectionHead title="Members" aside="who may log in is decided by your Access policy" />
      <Members />

      <SectionHead title="Spend" className="mt-s11" />
      <Spend />

      <SectionHead title="Sandboxes" className="mt-s11" />
      <Workspace />
    </>
  );
}
