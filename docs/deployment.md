# AWS ECS Deployment

This project deploys to AWS ECS Fargate with Pulumi from GitHub Actions.

## Cost Defaults

The Pulumi stack defaults are intentionally small:

- Fargate task: `cpu=256`, `memory=512`
- Desired task count: `1`
- CloudWatch log retention: `3` days
- ECR lifecycle policy: keep the latest `5` images
- Application Load Balancer: enabled permanently
- API Gateway HTTP API: enabled permanently

API Gateway is the main public service entry point. It forwards traffic through a VPC Link to the internal Application Load Balancer, and the load balancer forwards traffic to ECS. This is more stable than exposing the ECS task public IP directly, but the ALB adds a steady monthly cost.

## One-Time Setup

From the repo root:

```bash
cd infra
npm install
pulumi stack init dev
pulumi config set aws:region us-east-1
```

Optional low-cost stack settings:

```bash
pulumi config set desiredCount 1
pulumi config set cpu 256
pulumi config set memory 512
pulumi config set --path 'allowedCidrs[0]' '0.0.0.0/0'
```

The default stack excludes availability zone ID `use1-az3` from API Gateway VPC Link subnets because API Gateway VPC Link is not available there in this account. If you deploy to a different region or VPC, override the VPC Link subnets explicitly:

```bash
pulumi config set --path 'vpcLinkSubnetIds[0]' 'subnet-...'
pulumi config set --path 'vpcLinkSubnetIds[1]' 'subnet-...'
```

To stop runtime compute cost while keeping the infrastructure, set:

```bash
pulumi config set desiredCount 0
pulumi up
```

## GitHub Secrets And Variables

Repository secrets:

- `PULUMI_ACCESS_TOKEN`
- `AWS_ROLE_TO_ASSUME`

Repository variables:

- `AWS_REGION`, for example `us-east-1`
- `PULUMI_STACK`, for example `dev`

The GitHub workflow uses AWS OIDC. The AWS IAM role must trust your GitHub repo and have permissions to manage ECR, ECS, IAM roles/policies, EC2 security groups, CloudWatch logs, ALB resources, API Gateway v2 resources, and Cognito User Pools.

Example role trust policy. Replace `jharling/member-app-facade` if your GitHub owner or repo name is different.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:jharling/member-app-facade:*"
        }
      }
    }
  ]
}
```

For the first deployment, the role needs enough permissions to create and update the resources in `infra/index.ts`. The pragmatic bootstrap option is to attach `AdministratorAccess` temporarily, deploy once, then replace it with a tighter policy after the resource list is known from the Pulumi preview/update.

## Local Commands

Preview:

```bash
cd infra
npm run preview
```

Deploy:

```bash
cd infra
npm run deploy
```

After each deploy, Pulumi prints the current service URLs:

```bash
pulumi stack output serviceBaseUrl
pulumi stack output apiGatewayUrl
pulumi stack output loadBalancerUrl
pulumi stack output helloUrl
pulumi stack output swaggerUrl
```

`serviceBaseUrl` and `apiGatewayUrl` are the API Gateway URL and should be used as the public service URL. `loadBalancerUrl` is the internal ALB DNS name and is exported for AWS-side troubleshooting.

The GitHub deploy workflow also runs a scoped security smoke test after deployment. The test target comes from `pulumi stack output serviceBaseUrl`, and the resolved host is explicitly allowlisted for that run. The current CI gate fails only on `high` severity findings.

## Cognito Account API

Pulumi creates a Cognito User Pool and app client during deployment. The ECS task receives the app client ID in `COGNITO_USER_POOL_CLIENT_ID` and calls Cognito through the AWS SDK.

Account endpoints:

- `POST /accounts`
- `POST /accounts/confirm`
- `POST /accounts/login`
- `POST /accounts/forgot-password`
- `POST /accounts/forgot-password/confirm`

The Swagger page is available at:

```bash
pulumi stack output swaggerUrl
```

Destroy all AWS resources:

```bash
cd infra
npm run destroy
```
