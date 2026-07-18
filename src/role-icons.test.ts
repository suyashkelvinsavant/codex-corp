import { describe, expect, it } from "vitest";
import {
  Bug,
  ClipboardList,
  Image,
  Package,
  Palette,
  Server,
} from "lucide-react";
import { iconForPack, iconForSpecialistRole } from "./role-icons";

describe("role icons", () => {
  it("maps every builtin pack id to a distinct family of icons", () => {
    const pm = iconForPack({ id: "product-manager" });
    const delivery = iconForPack({ id: "delivery-agent" });
    const designer = iconForPack({ id: "designer" });
    const backend = iconForPack({ id: "backend-engineer" });
    const creative = iconForPack({ id: "creative", kind: "creative" });
    const qa = iconForPack({ id: "qa-engineer" });

    expect(pm).toBe(ClipboardList);
    expect(delivery).toBe(Package);
    expect(designer).toBe(Palette);
    expect(backend).toBe(Server);
    expect(creative).toBe(Image);
    expect(qa).toBe(Bug);
    expect(pm).not.toBe(delivery);
    expect(designer).not.toBe(backend);
  });

  it("resolves canvas nodes by role text when packId is missing", () => {
    expect(
      iconForSpecialistRole({ role: "Product Manager", kind: "agent" }),
    ).toBe(ClipboardList);
    expect(
      iconForSpecialistRole({ role: "Delivery Agent", kind: "agent" }),
    ).toBe(Package);
  });
});
