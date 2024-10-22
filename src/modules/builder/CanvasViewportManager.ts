import { WorkspaceLeaf } from "obsidian";

export class CanvasViewportManager {
  public viewportPosition: { x: number; y: number; zoom: number } = {
    x: 0,
    y: 0,
    zoom: 1,
  };
  public zoomStep: number = 0.1;
  public minZoom: number = -2;
  public maxZoom: number = 2;

  constructor() {
    this.viewportPosition = { x: 0, y: 0, zoom: 1 };
  }

  public handleCanvasKeyEvent(
    evt: KeyboardEvent,
    activeLeaf: WorkspaceLeaf | null
  ): boolean {
    if (!activeLeaf || activeLeaf.view.getViewType() !== "canvas") {
      return false;
    }

    const canvasView = activeLeaf.view as any;
    if (!canvasView.canvas) {
      console.error("Canvas not found in view");
      return false;
    }

    if (
      !canvasView.canvas.data ||
      !canvasView.canvas.data.systemsculptAIBuilder
    ) {
      console.log("Not a SystemSculpt AI Builder canvas");
      return false;
    }

    // Check if a node is selected or if the user is focused on an input element
    const activeElement = document.activeElement;
    if (
      canvasView.canvas.selection.size > 0 ||
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    ) {
      return false;
    }

    // Update the current viewport position
    this.updateViewportPosition(canvasView.canvas);

    const key = evt.key.toLowerCase();
    const step = 10; // Adjust this value to change the movement speed

    if (evt.shiftKey) {
      switch (key) {
        case "j":
        case "arrowdown":
          this.zoomCanvas(canvasView.canvas, -this.zoomStep);
          return true;
        case "k":
        case "arrowup":
          this.zoomCanvas(canvasView.canvas, this.zoomStep);
          return true;
      }
    } else {
      switch (key) {
        case "h":
        case "arrowleft":
          this.moveCanvas(canvasView.canvas, -step, 0);
          return true;
        case "j":
        case "arrowdown":
          this.moveCanvas(canvasView.canvas, 0, step);
          return true;
        case "k":
        case "arrowup":
          this.moveCanvas(canvasView.canvas, 0, -step);
          return true;
        case "l":
        case "arrowright":
          this.moveCanvas(canvasView.canvas, step, 0);
          return true;
      }
    }

    return false;
  }

  public updateViewportPosition(canvas: any) {
    if (
      canvas &&
      typeof canvas.x === "number" &&
      typeof canvas.y === "number" &&
      typeof canvas.zoom === "number"
    ) {
      this.viewportPosition = {
        x: canvas.x,
        y: canvas.y,
        zoom: canvas.zoom,
      };
    }
  }

  public moveCanvas(canvas: any, dx: number, dy: number) {
    if (canvas && typeof canvas.setViewport === "function") {
      const newX = this.viewportPosition.x + dx;
      const newY = this.viewportPosition.y + dy;

      console.log("Moving canvas to:", {
        x: newX,
        y: newY,
        zoom: this.viewportPosition.zoom,
      });

      try {
        canvas.setViewport(newX, newY, this.viewportPosition.zoom);
        this.viewportPosition = {
          x: newX,
          y: newY,
          zoom: this.viewportPosition.zoom,
        };
        console.log("Canvas moved successfully");
      } catch (error) {
        console.error("Error moving canvas:", error);
      }
    } else {
      console.error("Canvas or setViewport function not found");
    }
  }

  public zoomCanvas(canvas: any, zoomDelta: number) {
    if (canvas && typeof canvas.setViewport === "function") {
      const newZoom = Math.max(
        this.minZoom,
        Math.min(this.maxZoom, this.viewportPosition.zoom + zoomDelta)
      );

      console.log("Zooming canvas to:", {
        x: this.viewportPosition.x,
        y: this.viewportPosition.y,
        zoom: newZoom,
      });

      try {
        canvas.setViewport(
          this.viewportPosition.x,
          this.viewportPosition.y,
          newZoom
        );
        this.viewportPosition.zoom = newZoom;
        console.log("Canvas zoomed successfully");
      } catch (error) {
        console.error("Error zooming canvas:", error);
      }
    } else {
      console.error("Canvas or setViewport function not found");
    }
  }
}
