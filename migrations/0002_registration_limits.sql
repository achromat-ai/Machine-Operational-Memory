-- Migration 0002: indexes for the per-network registration caps
--
-- POST /api/v1/agents/register counts recent registrations from the caller IP
-- prefix (/24 or /48, HMAC-ed) and from the caller ASN before it inserts a key.
-- Partial indexes keep provisioned keys (no network data) out of both.

CREATE INDEX agent_identities_by_prefix ON agent_identities (ip_prefix_hmac, registered_at_ms)
  WHERE ip_prefix_hmac IS NOT NULL;

CREATE INDEX agent_identities_by_asn ON agent_identities (asn, registered_at_ms)
  WHERE asn IS NOT NULL;
