import assert from "node:assert/strict";
import test from "node:test";
import { basicChecks, scenarios } from "../lesson-eval.js";

test("basic lesson evaluation checks reject empty replies and roleplay refusals", () => {
  assert.deepEqual(basicChecks(["", "As an AI, I cannot roleplay."]), [
    "A tutor reply was empty.",
    "A reply contains an obvious refusal to continue roleplay.",
  ]);
});

test("translation scenario requires an English translation signal", () => {
  const scenario = scenarios.find(({ name }) => name === "translation-then-continuation");
  assert.ok(scenario);
  assert.deepEqual(scenario.check(["¿Qué?", "Enseguida."]), [
    "The translation reply did not contain an obvious English word.",
  ]);
});

test("out-of-lesson scenario rejects unsolicited corrections", () => {
  const scenario = scenarios.find(({ name }) => name === "valid-out-of-lesson-answer");
  assert.ok(scenario);
  assert.deepEqual(scenario.check(["Corrección: Me llamo Ruan."]), [
    "The valid out-of-lesson answer was corrected.",
  ]);
});

test("roleplay steering scenario rejects lesson explanations", () => {
  const scenario = scenarios.find(({ name }) => name === "roleplay-steering");
  assert.ok(scenario);
  assert.deepEqual(scenario.check(["This lesson teaches tapas vocabulary."]), [
    "A reply left roleplay to explain the lesson instead.",
  ]);
});
