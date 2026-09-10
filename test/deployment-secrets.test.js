const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveDeploymentSecretArns,
} = require("../scripts/deployment-secrets");

test("production reuses existing secrets without updating values", async () => {
  let putCalls = 0;
  const result = await resolveDeploymentSecretArns({
    allowUpdates: false,
    passwordSecretName: "password-name",
    authSecretName: "auth-name",
    passwordValue: "must-not-be-used",
    authValue: "must-not-be-used",
    putSecret: async () => {
      putCalls += 1;
      throw new Error("must not update production secrets");
    },
    describeSecret: async (name) => ({ ARN: `arn:test:${name}` }),
  });
  assert.deepEqual(result, ["arn:test:password-name", "arn:test:auth-name"]);
  assert.equal(putCalls, 0);
});

test("staging may update its isolated secrets", async () => {
  const writes = [];
  const result = await resolveDeploymentSecretArns({
    allowUpdates: true,
    passwordSecretName: "staging-password",
    authSecretName: "staging-auth",
    passwordValue: "password-value",
    authValue: "auth-value",
    putSecret: async (name, value) => {
      writes.push({ name, value });
      return `arn:test:${name}`;
    },
    describeSecret: async () => {
      throw new Error("staging should use putSecret");
    },
  });
  assert.deepEqual(result, ["arn:test:staging-password", "arn:test:staging-auth"]);
  assert.equal(writes.length, 2);
});
