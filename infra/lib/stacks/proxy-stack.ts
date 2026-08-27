import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';

export interface ProxyStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly taskSecurityGroup: ec2.SecurityGroup;
  readonly usersTable: dynamodb.ITable;
  readonly providersTable: dynamodb.ITable;
}

export class ProxyStack extends cdk.Stack {
  public readonly internalAlb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ProxyStackProps) {
    super(scope, id, props);
    const { config, vpc, privateSubnets, taskSecurityGroup, usersTable, providersTable } = props;

    // ── ALB Security Group ──
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Internal ALB - accepts traffic from Fargate Tasks only',
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(443), 'Tasks to ALB');

    // Task → ALB egress: use CfnSecurityGroupEgress to avoid cross-stack cycle
    new ec2.CfnSecurityGroupEgress(this, 'TaskToAlbEgress', {
      groupId: taskSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      destinationSecurityGroupId: this.albSecurityGroup.securityGroupId,
      description: 'Task to Internal ALB',
    });

    // ── Internal ALB ──
    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc,
      internetFacing: false,
      securityGroup: this.albSecurityGroup,
      vpcSubnets: { subnets: privateSubnets },
    });

    // ── Lambda Proxy Security Group ──
    const lambdaProxySg = new ec2.SecurityGroup(this, 'LambdaProxySg', {
      vpc,
      description: 'Lambda Proxy functions',
      allowAllOutbound: false,
    });
    // Lambda → VPC CIDR for backend access
    lambdaProxySg.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'Lambda to VPC backends');
    // Lambda → public internet for LiteLLM endpoint (via NAT Gateway)
    lambdaProxySg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Lambda to LiteLLM via NAT');
    this.albSecurityGroup.addEgressRule(lambdaProxySg, ec2.Port.allTcp(), 'ALB to Lambda');

    // ── LiteLLM Proxy Lambda ──
    const litellmProxy = new lambda.Function(this, 'LitellmProxy', {
      functionName: `openclaw-litellm-proxy-${config.stage}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(`${__dirname}/lambda/litellm-proxy`),
      timeout: cdk.Duration.seconds(120),
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaProxySg],
      environment: {
        LITELLM_URL: config.litellmEndpoint || 'http://litellm.internal:4000',
        ALLOWED_PATHS: '/v1/chat/completions,/v1/messages',
        RATE_LIMIT_TABLE: `openclaw-rate-limits-${config.stage}`,
        USERS_TABLE: usersTable.tableName,
        PROVIDERS_TABLE: providersTable.tableName,
      },
    });

    // Grant LiteLLM Proxy Lambda DynamoDB read permissions (GetItem/Query) on Users and Providers tables
    litellmProxy.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        usersTable.tableArn,
        providersTable.tableArn,
        // Include GSI ARNs for Query on secondary indexes
        `${providersTable.tableArn}/index/*`,
      ],
    }));

    // Grant LiteLLM Proxy Lambda Secrets Manager read for provider API keys
    litellmProxy.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:${config.partition || 'aws'}:secretsmanager:${this.region}:${this.account}:secret:openclaw/${config.stage}/providers/*`,
      ],
    }));

    // ── App Proxy Lambda ──
    const appProxy = new lambda.Function(this, 'AppProxy', {
      functionName: `openclaw-app-proxy-${config.stage}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(APP_PROXY_CODE),
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaProxySg],
      environment: {
        PERMISSIONS_TABLE: `openclaw-user-app-permissions-${config.stage}`,
      },
    });

    // ── ALB Listener + Rules ──
    const listener = this.internalAlb.addListener('Listener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // 不自动添加 0.0.0.0/0 ingress
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });

    listener.addTargets('LitellmTarget', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/llm/*'])],
      targets: [new targets.LambdaTarget(litellmProxy)],
    });

    listener.addTargets('AppTarget', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/app/*'])],
      targets: [new targets.LambdaTarget(appProxy)],
    });

    // ── Outputs ──
    new cdk.CfnOutput(this, 'InternalAlbDns', { value: this.internalAlb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'InternalAlbArn', { value: this.internalAlb.loadBalancerArn });
  }
}

const APP_PROXY_CODE = `
import json, os

def handler(event, context):
    user_id = event.get('headers', {}).get('x-openclaw-user-id', '')
    if not user_id:
        return {'statusCode': 401, 'body': 'Missing user identity'}

    path = event.get('path', '')
    method = event.get('httpMethod', 'GET')

    # TODO: 查 DynamoDB 权限矩阵，校验 user_id + app_id + method + path
    return {'statusCode': 200, 'body': json.dumps({'status': 'proxy placeholder'})}
`;
