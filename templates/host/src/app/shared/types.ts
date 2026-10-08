export interface Item {
  id: string;
  name: string;
}

/** Shape of a contribution to the "dashboard" extension point (validated in renderer/extension-points.ts). */
export interface ToolbarAction {
  id: string;
  label: string;
  command?: string;
}
