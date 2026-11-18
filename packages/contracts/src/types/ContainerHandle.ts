import type { InstanceType } from "./InstanceType";

export type ContainerHandle = {
  containerId: string;
  instanceType: InstanceType;
  egressCountry: string;
  readyAt: number;
};
