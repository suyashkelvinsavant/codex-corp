import { create } from "zustand";

export type DrawerTab =
  | "timeline"
  | "runs"
  | "approvals"
  | "logs"
  | "problems"
  | "artifacts"
  | "usage";
export type AppView = "overview" | "chat" | "architect" | "editor";

type UiState = {
  appView: AppView;
  /** Workflow opened in the mediator chat page. */
  chatWorkflowId: string | null;
  selectedId: string;
  selectedEdge: string | null;
  inspectorTab: string;
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  setAppView: (value: AppView) => void;
  setChatWorkflowId: (value: string | null) => void;
  setSelectedId: (value: string) => void;
  setSelectedEdge: (value: string | null) => void;
  setInspectorTab: (value: string) => void;
  setDrawerOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setDrawerTab: (value: DrawerTab) => void;
};

export const useUiStore = create<UiState>((set) => ({
  appView: "overview",
  chatWorkflowId: null,
  selectedId: "builder",
  selectedEdge: null,
  inspectorTab: "overview",
  drawerOpen: true,
  drawerTab: "timeline",
  setAppView: (appView) => set({ appView }),
  setChatWorkflowId: (chatWorkflowId) => set({ chatWorkflowId }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setSelectedEdge: (selectedEdge) => set({ selectedEdge }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setDrawerOpen: (value) =>
    set((state) => ({
      drawerOpen:
        typeof value === "function" ? value(state.drawerOpen) : value,
    })),
  setDrawerTab: (drawerTab) => set({ drawerTab }),
}));
