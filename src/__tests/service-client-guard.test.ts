// Import External Packages
import { afterEach, describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import {
  allowProofServiceHosts,
  createProofServiceClient,
  proofServiceHostProblem,
} from "../server/service-client";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// The proof suite deletes auth users and workspaces, so the service client
// must refuse every target that is not unmistakably local. These tests pin
// the properties that make the guard trustworthy:
//
//   1. The PARSED hostname is compared, never a substring —
//      `https://localhost.example.com` is the case a substring check passes.
//   2. There is no environment-variable override; widening the blast radius
//      is a code-level call (`allowProofServiceHosts`) that shows in a diff.
//   3. An unparseable URL is refused rather than assumed local.
// ---------------------------------------------------------------------------

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("proofServiceHostProblem", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "https://localhost",
    "http://[::1]:54321",
  ])("accepts the local target %s", (url) => {
    expect(proofServiceHostProblem(url)).toBeNull();
  });

  it("refuses a hosted project", () => {
    expect(proofServiceHostProblem("https://abcdefg.supabase.co")).toContain(
      "non-local",
    );
  });

  it("refuses a hostname that merely contains 'localhost'", () => {
    expect(
      proofServiceHostProblem("https://localhost.example.com"),
    ).toContain("localhost.example.com");
  });

  it("refuses an unparseable URL instead of assuming it is local", () => {
    expect(proofServiceHostProblem("not a url")).toContain("not a parseable");
  });

  it("accepts a host from an explicit allow set", () => {
    expect(
      proofServiceHostProblem("http://kong:8000", new Set(["kong"])),
    ).toBeNull();
    expect(proofServiceHostProblem("http://kong:8000", new Set())).toContain(
      "kong",
    );
  });
});

describe("createProofServiceClient", () => {
  it("hard-aborts on a non-local NEXT_PUBLIC_SUPABASE_URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefg.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    expect(() => createProofServiceClient()).toThrow(/unsafe_database/);
    // The message must steer toward the code-level allowance, not an env var.
    expect(() => createProofServiceClient()).toThrow(
      /allowProofServiceHosts/,
    );
  });

  it("constructs a client for a local target", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    expect(createProofServiceClient()).toBeTruthy();
  });

  it("honors hosts registered via allowProofServiceHosts", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase-ci:8000";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    expect(() => createProofServiceClient()).toThrow(/unsafe_database/);
    allowProofServiceHosts(["supabase-ci"]);
    expect(createProofServiceClient()).toBeTruthy();
  });
});
