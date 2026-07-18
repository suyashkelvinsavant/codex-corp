import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { listPacksForCatalog, type NodePack } from "./node-packs";
import { iconForPack } from "./role-icons";

export type RoleCatalogMenuProps = {
  /** Screen coordinates for the floating menu. */
  x: number;
  y: number;
  onSelect: (pack: NodePack) => void;
  onCancel: () => void;
};

/**
 * Role catalog shown when placing a generic Agent (or opening the pack picker).
 * Empty pack is listed last via pack.menuOrder.
 */
export function RoleCatalogMenu({
  x,
  y,
  onSelect,
  onCancel,
}: RoleCatalogMenuProps) {
  const packs = listPacksForCatalog();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onCancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [onCancel]);

  return (
    <div
      ref={rootRef}
      className="role-catalog-menu"
      role="dialog"
      aria-label="Choose specialist role"
      style={{ left: x, top: y }}
    >
      <div className="role-catalog-menu-header">
        <b>Choose role</b>
        <button
          type="button"
          className="modal-close role-catalog-close"
          aria-label="Close role catalog"
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>
      <p className="helper">
        Pick a builtin specialist pack. Empty uses neutral harness-core.
      </p>
      <ul className="role-catalog-list">
        {packs.map((pack) => {
          const PackIcon = iconForPack(pack);
          return (
            <li key={pack.id}>
              <button
                type="button"
                className="role-catalog-item"
                onClick={() => onSelect(pack)}
              >
                <PackIcon size={14} aria-hidden />
                <span>
                  <b>{pack.label}</b>
                  <small>{pack.description}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
