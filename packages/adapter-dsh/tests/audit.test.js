import test from "node:test"
import assert from "node:assert/strict"
import { auditTurn, MAX_REPAIRS, newTurnEvidence } from "../lib/audit.js"

test("requires a verification call, not just a passive read", () => {
  const ev = newTurnEvidence()
  ev.toolCalls = 1
  ev.toolResults = 1 // a read that "succeeded" is not verification
  assert.equal(auditTurn(ev, true), "repair")
})

test("passes with a verification call and no errors", () => {
  const ev = newTurnEvidence()
  ev.verificationCalls = 1
  ev.toolResults = 1
  assert.equal(auditTurn(ev, true), "verified")
})

test("repairs on tool errors", () => {
  const ev = newTurnEvidence()
  ev.verificationCalls = 1
  ev.toolErrors = 1
  assert.equal(auditTurn(ev, true), "repair")
})

test("fails after MAX_REPAIRS instead of looping forever", () => {
  const ev = newTurnEvidence()
  ev.repairCount = MAX_REPAIRS
  assert.equal(auditTurn(ev, true), "failed")
})

test("passes when requireEvidence is disabled", () => {
  assert.equal(auditTurn(newTurnEvidence(), false), "verified")
})
