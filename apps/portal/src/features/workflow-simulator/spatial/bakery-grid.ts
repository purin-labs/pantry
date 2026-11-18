import * as THREE from "three";
import { bakeryGrid } from "@seams/production-simulation/floor/bakery-room";

export function createBakeryGrid(): THREE.GridHelper {
  const size = 12;
  const grid = new THREE.GridHelper(size, size / bakeryGrid.secondary);
  grid.position.y = 0.005;
  updateBakeryGrid(grid, false);
  return grid;
}

export function updateBakeryGrid(grid: THREE.GridHelper, dark: boolean): void {
  const primaryColor = new THREE.Color(dark ? "#71796e" : "#aab5a0");
  const secondaryColor = new THREE.Color(dark ? "#484f48" : "#c5cdbd");
  const positions = grid.geometry.getAttribute("position");
  const colors = grid.geometry.getAttribute("color");
  for (let vertex = 0; vertex < positions.count; vertex += 2) {
    const x = positions.getX(vertex);
    const z = positions.getZ(vertex);
    const coordinate = x === positions.getX(vertex + 1) ? x : z;
    const primary = Number.isInteger(coordinate / bakeryGrid.primary);
    const color = primary ? primaryColor : secondaryColor;
    colors.setXYZ(vertex, color.r, color.g, color.b);
    colors.setXYZ(vertex + 1, color.r, color.g, color.b);
  }
  colors.needsUpdate = true;
}
