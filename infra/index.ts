import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";
import { execFileSync } from "child_process";

const appName = "member-app-facade";
const containerPort = 8080;

const config = new pulumi.Config();
const desiredCount = config.getNumber("desiredCount") ?? 1;
const cpu = config.get("cpu") ?? "256";
const memory = config.get("memory") ?? "512";
const allowedCidrs = config.getObject<string[]>("allowedCidrs") ?? ["0.0.0.0/0"];
const configuredVpcId = config.get("vpcId");
const configuredSubnetIds = config.getObject<string[]>("subnetIds");
const enableLoadBalancer = config.getBoolean("enableLoadBalancer") ?? false;
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

const taskExecutionRole = new aws.iam.Role("task-execution-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ecs-tasks.amazonaws.com",
    }),
});

new aws.iam.RolePolicyAttachment("task-execution-policy", {
    role: taskExecutionRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

const serviceSecurityGroup = new aws.ec2.SecurityGroup("service-security-group", {
    name: `${appName}-service`,
    description: "Allow HTTP traffic to the ECS task",
    vpcId: defaultVpc.id,
    ingress: [{
        protocol: "tcp",
        fromPort: containerPort,
        toPort: containerPort,
        cidrBlocks: allowedCidrs,
        description: "Application HTTP traffic",
    }],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Outbound internet access",
    }],
});

let loadBalancer: aws.lb.LoadBalancer | undefined;
let targetGroup: aws.lb.TargetGroup | undefined;
let listener: aws.lb.Listener | undefined;

if (enableLoadBalancer) {
    const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("load-balancer-security-group", {
        name: `${appName}-alb`,
        description: "Allow public HTTP traffic to the load balancer",
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

    loadBalancer = new aws.lb.LoadBalancer("load-balancer", {
        name: `${appName}-alb`,
        loadBalancerType: "application",
        subnets: subnetIds,
        securityGroups: [loadBalancerSecurityGroup.id],
    });

    targetGroup = new aws.lb.TargetGroup("target-group", {
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

    listener = new aws.lb.Listener("listener", {
        loadBalancerArn: loadBalancer.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [{
            type: "forward",
            targetGroupArn: targetGroup.arn,
        }],
    });
}

const taskDefinition = new aws.ecs.TaskDefinition("task-definition", {
    family: appName,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu,
    memory,
    executionRoleArn: taskExecutionRole.arn,
    containerDefinitions: pulumi.jsonStringify([{
        name: appName,
        image: image.ref,
        essential: true,
        portMappings: [{
            containerPort,
            hostPort: containerPort,
            protocol: "tcp",
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
    loadBalancers: targetGroup ? [{
        targetGroupArn: targetGroup.arn,
        containerName: appName,
        containerPort,
    }] : undefined,
}, {
    dependsOn: listener ? [listener] : undefined,
});

function runAwsJson(args: string[]): any {
    const stdout = execFileSync("aws", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    return JSON.parse(stdout);
}

const directTaskBaseUrl = pulumi
    .all([cluster.name, service.name, currentRegion.name, pulumi.output(desiredCount), service.id])
    .apply(([clusterName, serviceName, region, configuredDesiredCount]) => {
        if (configuredDesiredCount < 1) {
            return "disabled: desiredCount is 0";
        }

        execFileSync("aws", [
            "ecs", "wait", "services-stable",
            "--cluster", clusterName,
            "--services", serviceName,
            "--region", region,
        ], { stdio: "ignore" });

        const tasks = runAwsJson([
            "ecs", "list-tasks",
            "--cluster", clusterName,
            "--service-name", serviceName,
            "--desired-status", "RUNNING",
            "--region", region,
        ]);
        const taskArn = tasks.taskArns?.[0];

        if (!taskArn) {
            return "unavailable: no running ECS task found";
        }

        const taskDescription = runAwsJson([
            "ecs", "describe-tasks",
            "--cluster", clusterName,
            "--tasks", taskArn,
            "--region", region,
        ]);
        const eniId = taskDescription.tasks?.[0]?.attachments
            ?.flatMap((attachment: any) => attachment.details ?? [])
            ?.find((detail: any) => detail.name === "networkInterfaceId")
            ?.value;

        if (!eniId) {
            return "unavailable: no ECS task network interface found";
        }

        const networkInterface = runAwsJson([
            "ec2", "describe-network-interfaces",
            "--network-interface-ids", eniId,
            "--region", region,
        ]);
        const publicIp = networkInterface.NetworkInterfaces?.[0]?.Association?.PublicIp;

        if (!publicIp) {
            return "unavailable: ECS task does not have a public IP";
        }

        return `http://${publicIp}:${containerPort}`;
    });

export const repositoryUrl = repository.repositoryUrl;
export const imageRef = image.ref;
export const clusterName = cluster.name;
export const serviceName = service.name;
export const taskFamily = taskDefinition.family;
export const loadBalancerUrl = loadBalancer
    ? pulumi.interpolate`http://${loadBalancer.dnsName}`
    : "disabled";
export const serviceBaseUrl = loadBalancer
    ? pulumi.interpolate`http://${loadBalancer.dnsName}`
    : directTaskBaseUrl;
export const helloUrl = pulumi.interpolate`${serviceBaseUrl}/hello`;
export const swaggerUrl = pulumi.interpolate`${serviceBaseUrl}/swagger-ui.html`;
export const notes = enableLoadBalancer
    ? "Use loadBalancerUrl for the public endpoint."
    : "serviceBaseUrl uses the current ECS task public IP to minimize cost. It can change when ECS replaces the task. Set enableLoadBalancer=true for a stable URL.";
