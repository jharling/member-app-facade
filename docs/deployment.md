# AWS ECS Deployment

This project deploys to AWS ECS Fargate with Pulumi from GitHub Actions.

## Cost Defaults

The Pulumi stack defaults are intentionally small:

- Fargate task: `cpu=256`, `memory=512`
- Desired task count: `1`
- CloudWatch log retention: `3` days
- ECR lifecycle policy: keep the latest `5` images
- Application Load Balancer: disabled by default

An ALB gives you a stable public URL, but it adds a steady monthly cost. With the default low-cost setup, the ECS task gets a public IP directly, but that IP can change when the task is replaced.

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
pulumi config set enableLoadBalancer false
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

The GitHub workflow uses AWS OIDC. The AWS IAM role must trust your GitHub repo and have permissions to manage ECR, ECS, IAM roles/policies, EC2 security groups, CloudWatch logs, and optionally ALB resources.

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

## Optional Load Balancer

Enable a stable public URL:

```bash
cd infra
pulumi config set enableLoadBalancer true
pulumi up
pulumi stack output loadBalancerUrl
```

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
pulumi stack output helloUrl
pulumi stack output swaggerUrl
```

When `enableLoadBalancer=false`, these outputs use the current ECS task public IP, which can change when ECS replaces the task. When `enableLoadBalancer=true`, they use the load balancer DNS name.

The GitHub deploy workflow also runs a scoped security smoke test after deployment. The test target comes from `pulumi stack output serviceBaseUrl`, and the resolved host is explicitly allowlisted for that run. The current CI gate fails only on `high` severity findings so the known HTTP/TLS limitation of the low-cost no-load-balancer setup is reported without blocking deployment.

Destroy all AWS resources:

```bash
cd infra
npm run destroy
```
