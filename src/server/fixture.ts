// Import External Packages
import type { SupabaseClient } from "@supabase/supabase-js";
// Import Local Imports
import type { SeedUser, SeedWorkspace } from "./seed";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

/**
 * Seed handles available to a tenant-isolation fixture factory.
 *
 * A factory normally inserts one row for each side so the helper can prove both
 * isolation directions. It may use fewer handles when the table is user-scoped
 * or when an existing seeded workspace/user row is itself the fixture.
 */
export interface ProofFixtureContext {
  orgA: SeedWorkspace;
  orgB: SeedWorkspace;
  userA: SeedUser;
  userB: SeedUser;
  sb: SupabaseClient;
}

/**
 * Explicit, table-owned setup contract for a Proof fixture.
 *
 * Keep factories under `e2e/fixtures/<table>.ts`. The table name is repeated at
 * runtime so a copied factory cannot silently seed one table while a proof
 * probes another.
 */
export interface ProofFixtureFactory<TTable extends string = string> {
  readonly table: TTable;
  create(context: ProofFixtureContext): Promise<void>;
}

export interface DefineProofFixtureOptions<TTable extends string> {
  table: TTable;
  create(context: ProofFixtureContext): Promise<void>;
}

/** Define a completed, explicit fixture factory. */
export function defineProofFixture<const TTable extends string>(
  options: DefineProofFixtureOptions<TTable>,
): ProofFixtureFactory<TTable> {
  return Object.freeze({
    table: options.table,
    create: options.create,
  });
}

/**
 * Error used when a proof exists before its table's valid fixture shape is
 * known. `assert.tenantIsolation` recognizes it and records an incomplete
 * assertion rather than allowing the missing setup to look green.
 */
export class ProofFixturePendingError extends Error {
  readonly code = "fixture_factory_required";

  constructor(
    readonly table: string,
    readonly reason: string,
  ) {
    super(
      `Fixture factory for "${table}" is incomplete: ${reason}. Complete e2e/fixtures/${table}.ts with values valid for the final schema.`,
    );
    this.name = "ProofFixturePendingError";
  }
}

/**
 * Declare the intentional pre-schema state of a fixture.
 *
 * The builder replaces this with `defineProofFixture(...)` after migrations
 * settle. Until then the proof remains explicitly incomplete.
 */
export function pendingProofFixture<const TTable extends string>(
  table: TTable,
  reason = "the table schema and product constraints are not final",
): ProofFixtureFactory<TTable> {
  return defineProofFixture({
    table,
    async create() {
      throw new ProofFixturePendingError(table, reason);
    },
  });
}

export function isProofFixturePendingError(
  error: unknown,
): error is ProofFixturePendingError {
  return error instanceof ProofFixturePendingError;
}
