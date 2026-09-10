async function resolveDeploymentSecretArns({
  allowUpdates,
  passwordSecretName,
  authSecretName,
  passwordValue,
  authValue,
  putSecret,
  describeSecret,
}) {
  if (allowUpdates) {
    return Promise.all([
      putSecret(passwordSecretName, passwordValue),
      putSecret(authSecretName, authValue),
    ]);
  }

  const descriptions = await Promise.all([
    describeSecret(passwordSecretName),
    describeSecret(authSecretName),
  ]);
  const arns = descriptions.map((secret) => secret?.ARN || "");
  if (arns.some((arn) => !arn)) {
    throw new Error("本番の既存Secrets Manager ARNを確認できませんでした。");
  }
  return arns;
}

module.exports = { resolveDeploymentSecretArns };
