import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";

const appName = "member-app-facade";
const containerPort = 8080;

const config = new pulumi.Config();
const desiredCount = config.getNumber("desiredCount") ?? 1;
const cpu = config.get("cpu") ?? "256";
const memory = config.get("memory") ?? "512";
const allowedCidrs = config.getObject<string[]>("allowedCidrs") ?? ["0.0.0.0/0"];
const configuredVpcId = config.get("vpcId");
const configuredSubnetIds = config.getObject<string[]>("subnetIds");
const currentRegion = aws.getRegionOutput({});

const defaultVpc = configuredVpcId
    ? aws.ec2.getVpcOutput({ id: configuredVpcId })
    : aws.ec2.getVpcOutput({ default: true });

const defaultSubnets = configuredSubnetIds
    ? undefined
    : aws.ec2.getSubnetsOutput({
        filters: [
            { name: "vpc-id", values: [defaultVpc.id] },
            { name: "default-for-az", values: ["true"] },
        ],
    });

const subnetIds: pulumi.Input<pulumi.Input<string>[]> = configuredSubnetIds ?? defaultSubnets!.ids;

const repository = new aws.ecr.Repository("repository", {
    name: appName,
    forceDelete: true,
    imageScanningConfiguration: {
        scanOnPush: true,
    },
});

new aws.ecr.LifecyclePolicy("repository-lifecycle", {
    repository: repository.name,
    policy: JSON.stringify({
        rules: [{
            rulePriority: 1,
            description: "Keep only the last five images to reduce ECR storage costs",
            selection: {
                tagStatus: "any",
                countType: "imageCountMoreThan",
                countNumber: 5,
            },
            action: {
                type: "expire",
            },
        }],
    }),
});

const authToken = aws.ecr.getAuthorizationTokenOutput({
    registryId: repository.registryId,
});

const image = new dockerBuild.Image("image", {
    tags: [pulumi.interpolate`${repository.repositoryUrl}:latest`],
    context: {
        location: "..",
    },
    dockerfile: {
        location: "../Dockerfile",
    },
    cacheFrom: [{
        registry: {
            ref: pulumi.interpolate`${repository.repositoryUrl}:latest`,
        },
    }],
    cacheTo: [{
        inline: {},
    }],
    platforms: ["linux/amd64"],
    push: true,
    registries: [{
        address: repository.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
    }],
});

const logGroup = new aws.cloudwatch.LogGroup("app-logs", {
    name: `/ecs/${appName}`,
    retentionInDays: 3,
});

const cluster = new aws.ecs.Cluster("cluster", {
    name: appName,
});

const userPool = new aws.cognito.UserPool("user-pool", {
    name: appName,
    usernameAttributes: ["email"],
    autoVerifiedAttributes: ["email"],
    passwordPolicy: {
        minimumLength: 8,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: false,
        requireUppercase: true,
    },
    schemas: [{
        attributeDataType: "String",
        name: "email",
        required: true,
        mutable: true,
    }],
});

const userPoolClient = new aws.cognito.UserPoolClient("user-pool-client", {
    name: `${appName}-client`,
    userPoolId: userPool.id,
    generateSecret: false,
    explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_SRP_AUTH",
    ],
    preventUserExistenceErrors: "ENABLED",
});

const taskExecutionRole = new aws.iam.Role("task-execution-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ecs-tasks.amazonaws.com",
    }),
});

new aws.iam.RolePolicyAttachment("task-execution-policy", {
    role: taskExecutionRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

const taskRole = new aws.iam.Role("task-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ecs-tasks.amazonaws.com",
    }),
});

new aws.iam.RolePolicy("task-cognito-policy", {
    role: taskRole.id,
    policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "cognito-idp:SignUp",
                "cognito-idp:ConfirmSignUp",
                "cognito-idp:InitiateAuth",
                "cognito-idp:ForgotPassword",
                "cognito-idp:ConfirmForgotPassword",
            ],
            Resource: userPool.arn,
        }],
    }),
});

const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("load-balancer-security-group", {
    name: `${appName}-alb`,
    description: "Allow HTTP traffic to the load balancer",
    vpcId: defaultVpc.id,
    ingress: [{
        protocol: "tcp",
        fromPort: 80,
        toPort: 80,
        cidrBlocks: allowedCidrs,
        description: "Public HTTP traffic",
    }],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Outbound traffic",
    }],
});

const serviceSecurityGroup = new aws.ec2.SecurityGroup("service-security-group", {
    name: `${appName}-service`,
    description: "Allow HTTP traffic to the ECS task",
    vpcId: defaultVpc.id,
    ingress: [{
        protocol: "tcp",
        fromPort: containerPort,
        toPort: containerPort,
        securityGroups: [loadBalancerSecurityGroup.id],
        description: "Application HTTP traffic from load balancer",
    }],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Outbound internet access",
    }],
});

const loadBalancer = new aws.lb.LoadBalancer("load-balancer", {
    name: `${appName}-alb`,
    loadBalancerType: "application",
    subnets: subnetIds,
    securityGroups: [loadBalancerSecurityGroup.id],
});

const targetGroup = new aws.lb.TargetGroup("target-group", {
    name: `${appName}-tg`,
    port: containerPort,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: defaultVpc.id,
    healthCheck: {
        path: "/hello",
        matcher: "200",
    },
});

const listener = new aws.lb.Listener("listener", {
    loadBalancerArn: loadBalancer.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});

const api = new aws.apigatewayv2.Api("api", {
    name: appName,
    protocolType: "HTTP",
});

const apiIntegration = new aws.apigatewayv2.Integration("api-integration", {
    apiId: api.id,
    integrationType: "HTTP_PROXY",
    integrationMethod: "ANY",
    integrationUri: pulumi.interpolate`http://${loadBalancer.dnsName}`,
    payloadFormatVersion: "1.0",
});

new aws.apigatewayv2.Route("api-root-route", {
    apiId: api.id,
    routeKey: "ANY /",
    target: pulumi.interpolate`integrations/${apiIntegration.id}`,
});

new aws.apigatewayv2.Route("api-proxy-route", {
    apiId: api.id,
    routeKey: "ANY /{proxy+}",
    target: pulumi.interpolate`integrations/${apiIntegration.id}`,
});

new aws.apigatewayv2.Stage("api-stage", {
    apiId: api.id,
    name: "$default",
    autoDeploy: true,
});

const taskDefinition = new aws.ecs.TaskDefinition("task-definition", {
    family: appName,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu,
    memory,
    executionRoleArn: taskExecutionRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([{
        name: appName,
        image: image.ref,
        essential: true,
        portMappings: [{
            containerPort,
            hostPort: containerPort,
            protocol: "tcp",
        }],
        environment: [{
            name: "COGNITO_USER_POOL_CLIENT_ID",
            value: userPoolClient.id,
        }, {
            name: "AWS_REGION",
            value: currentRegion.name,
        }],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": logGroup.name,
                "awslogs-region": currentRegion.name,
                "awslogs-stream-prefix": appName,
            },
        },
    }]),
});

const service = new aws.ecs.Service("service", {
    name: appName,
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount,
    launchType: "FARGATE",
    networkConfiguration: {
        assignPublicIp: true,
        subnets: subnetIds,
        securityGroups: [serviceSecurityGroup.id],
    },
    loadBalancers: [{
        targetGroupArn: targetGroup.arn,
        containerName: appName,
        containerPort,
    }],
}, {
    dependsOn: [listener],
});

export const repositoryUrl = repository.repositoryUrl;
export const imageRef = image.ref;
export const clusterName = cluster.name;
export const serviceName = service.name;
export const taskFamily = taskDefinition.family;
export const userPoolId = userPool.id;
export const userPoolClientId = userPoolClient.id;
export const loadBalancerUrl = pulumi.interpolate`http://${loadBalancer.dnsName}`;
export const apiGatewayUrl = api.apiEndpoint;
export const serviceBaseUrl = api.apiEndpoint;
export const helloUrl = pulumi.interpolate`${serviceBaseUrl}/hello`;
export const swaggerUrl = pulumi.interpolate`${serviceBaseUrl}/swagger-ui.html`;
export const notes = "Use apiGatewayUrl/serviceBaseUrl for the public endpoint. API Gateway forwards to the load balancer, which forwards to ECS.";
