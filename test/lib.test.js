import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAccessIp,
  trimDeviceEntries,
  MAX_IPS_PER_DEVICE,
} from "../src/lib.js";

describe("normalizeAccessIp", () => {
  it("adds /32 for bare IPv4", () => {
    assert.equal(normalizeAccessIp("203.0.113.10"), "203.0.113.10/32");
  });

  it("preserves valid IPv4 CIDR", () => {
    assert.equal(normalizeAccessIp("203.0.113.0/24"), "203.0.113.0/24");
  });

  it("adds /128 for bare IPv6", () => {
    assert.equal(normalizeAccessIp("2001:db8::1"), "2001:db8::1/128");
  });

  it("preserves valid IPv6 CIDR", () => {
    assert.equal(normalizeAccessIp("2001:db8::/32"), "2001:db8::/32");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeAccessIp("  198.51.100.1  "), "198.51.100.1/32");
  });

  it("rejects invalid values", () => {
    assert.equal(normalizeAccessIp(""), null);
    assert.equal(normalizeAccessIp("not-an-ip"), null);
    assert.equal(normalizeAccessIp("203.0.113.10/33"), null);
    assert.equal(normalizeAccessIp("203.0.113.10/24/8"), null);
    assert.equal(normalizeAccessIp(null), null);
    assert.equal(normalizeAccessIp(42), null);
  });
});

describe("trimDeviceEntries (MAX_IPS_PER_DEVICE eviction)", () => {
  it("returns a shallow copy when under the limit", () => {
    const entries = [
      { ip: "203.0.113.1/32", ts: 100 },
      { ip: "203.0.113.2/32", ts: 200 },
    ];
    const out = trimDeviceEntries(entries, 8);
    assert.equal(out.length, 2);
    assert.notEqual(out, entries);
    assert.deepEqual(out, entries);
  });

  it("keeps newest entries when over the limit", () => {
    const entries = [];
    for (let i = 0; i < 12; i++) {
      entries.push({ ip: `203.0.113.${i}/32`, ts: i + 1 });
    }
    const out = trimDeviceEntries(entries, MAX_IPS_PER_DEVICE);
    assert.equal(out.length, MAX_IPS_PER_DEVICE);
    assert.equal(out[0].ts, 12);
    assert.equal(out[MAX_IPS_PER_DEVICE - 1].ts, 12 - MAX_IPS_PER_DEVICE + 1);
    assert.ok(!out.some((e) => e.ts <= 4));
  });

  it("handles non-array input", () => {
    assert.deepEqual(trimDeviceEntries(null), []);
    assert.deepEqual(trimDeviceEntries(undefined), []);
  });
});
