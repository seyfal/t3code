/**
 * PrimeAgentAdapter — shape type for the PrimeAgent provider adapter.
 *
 * The driver model ({@link ../Drivers/PrimeAgentDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module PrimeAgentAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * PrimeAgentAdapterShape — per-instance PrimeAgent adapter contract.
 */
export interface PrimeAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
