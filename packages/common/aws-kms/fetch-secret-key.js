const { GetSecretValueCommand , SecretsManagerClient} = require("@aws-sdk/client-secrets-manager");
const secret_name = "test-secret-key";

const client = new SecretsManagerClient({
  region: "us-east-2",
});

let response;

async function getSecretValue() {
  try {
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
      })
    );
    console.log('response: ', response)
    return response;
  } catch (error) {
    // For a list of exceptions thrown, see
    // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
    throw error;
  }
}
