import { z } from "zod";

/**
 * AIP DID grammar: did:aip:{wallet}:{agent_id}
 *
 * - scheme is the literal "did:aip"
 * - wallet is a base58-like Solana-style id. The alphabet is left broad
 *   ([a-zA-Z0-9]+) rather than the strict base58 set so future wallet variants
 *   do not require a parser change; strict on-chain validation is an upstream
 *   concern, not this seam's.
 * - agent_id is a slug ([a-z0-9-]+): lowercase alphanumerics and hyphens.
 *
 * The pattern is anchored and forbids extra colons, so a DID with more than the
 * three parts is rejected.
 */
export const AIP_DID_REGEX = /^did:aip:([a-zA-Z0-9]+):([a-z0-9-]+)$/;

/** A parsed AIP DID broken into its addressable parts. */
export interface AipDid {
  /** The full canonical DID string. */
  did: string;
  /** The base58-like wallet segment. */
  wallet: string;
  /** The slug agent identifier. */
  agentId: string;
}

/**
 * Zod schema that accepts a raw DID string and produces a structured AipDid.
 * Validation happens at the regex boundary, then the captured groups are
 * surfaced as named fields so callers never re-split the string themselves.
 */
export const AipDidSchema = z
  .string()
  .regex(AIP_DID_REGEX, "must match did:aip:{wallet}:{agent_id}")
  .transform((did): AipDid => {
    const match = AIP_DID_REGEX.exec(did);
    // The regex already validated; this assertion is defensive only.
    if (!match) throw new Error(`unreachable: ${did} passed regex but failed exec`);
    return { did, wallet: match[1], agentId: match[2] };
  });

/**
 * Parse and validate an AIP DID. Throws a ZodError when the input does not match
 * the grammar. Callers that want a soft check should use AipDidSchema.safeParse.
 */
export function parseAipDid(input: string): AipDid {
  return AipDidSchema.parse(input);
}

/**
 * Serialize wallet and agentId back into a canonical DID string. The result is
 * validated so formatAipDid can never emit a DID that parseAipDid would reject;
 * this keeps the parse/format round-trip total.
 */
export function formatAipDid(wallet: string, agentId: string): string {
  const did = `did:aip:${wallet}:${agentId}`;
  // Validate the inputs so a bad wallet or agent_id fails loudly at format time.
  parseAipDid(did);
  return did;
}
