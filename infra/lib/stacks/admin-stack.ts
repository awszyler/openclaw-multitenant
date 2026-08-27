import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';
import { regionShortName, ecrDomain } from '../config';

export interface AdminStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly usersTable: dynamodb.ITable;
  readonly providersTable: dynamodb.ITable;
  readonly auditLogsTable: dynamodb.ITable;
  readonly ecsCluster: ecs.ICluster;
  readonly taskSecurityGroup: ec2.SecurityGroup;
  readonly vpcEndpointSecurityGroup?: ec2.SecurityGroup;
  readonly internalAlbDns?: string;
}

export class AdminStack extends cdk.Stack {
  public readonly apiGateway: apigateway.RestApi;
  public readonly consoleBucket: s3.Bucket;
  public readonly consoleOai: cloudfront.OriginAccessIdentity;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const {
      config,
      vpc,
      privateSubnets,
      usersTable,
      providersTable,
      auditLogsTable,
      ecsCluster,
      taskSecurityGroup,
    } = props;

    const partition = config.partition || 'aws';
    const deploymentMode = config.deploymentMode || 'global';

    // ── Authentication Resources (conditional on deploymentMode) ──
    const lambdaAuthEnv: Record<string, string> = {
      DEPLOYMENT_MODE: deploymentMode,
    };

    if (deploymentMode === 'global') {
      // Cognito User Pool + App Client + openclaw-admins group
      const userPool = new cognito.UserPool(this, 'AdminUserPool', {
        userPoolName: `openclaw-admin-${config.stage}`,
        selfSignUpEnabled: false,
        signInAliases: { email: true, username: true },
        autoVerify: { email: true },
        passwordPolicy: {
          minLength: 8,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: false,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      const userPoolClient = userPool.addClient('AdminClient', {
        userPoolClientName: `openclaw-admin-client-${config.stage}`,
        authFlows: {
          userPassword: true,
          userSrp: true,
        },
        generateSecret: false,
      });

      const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
        userPoolId: userPool.userPoolId,
        groupName: 'openclaw-admins',
        description: 'OpenClaw administrators group',
      });

      lambdaAuthEnv.COGNITO_USER_POOL_ID = userPool.userPoolId;
      lambdaAuthEnv.COGNITO_CLIENT_ID = userPoolClient.userPoolClientId;

      new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
      new cdk.CfnOutput(this, 'CognitoClientId', { value: userPoolClient.userPoolClientId });

      // ── 初始管理员用户：刻意不由 CDK 创建 ──
      // 设计约束：初始凭证不经过 CloudFormation。用户池与组由 CDK 建，
      // 初始管理员由运维在部署后用一条命令创建（见 README「创建初始管理员」）。
      //
      // 如果打算把它改回自动创建，注意两个坑：
      //   - 不要在 synth 期从 account/region/stage 之类的非秘密值派生密码，
      //     那样每个部署的初始密码都是可计算的；
      //   - {{resolve:secretsmanager:...}} 动态引用只在有限的资源类型/属性里
      //     被 CloudFormation 解析，Custom::AWS 不在其中 —— 字面量会原样
      //     传给下游 API 并成为真实密码。
      // 要自动化就得让自定义资源自己生成密码并写入 Secrets Manager，
      // 而不是让模板去引用它。
      new cdk.CfnOutput(this, 'AdminGroupName', {
        value: adminGroup.groupName!,
        description:
          'Cognito group for administrators. Create the initial admin user after deploy — see the "创建初始管理员" section in README. This stack deliberately does not create any user, so no credential ever passes through CloudFormation.',
      });
    } else {
      // China mode: Auth Users DynamoDB table
      const authUsersTable = new dynamodb.Table(this, 'AuthUsersTable', {
        tableName: `openclaw-auth-users-${config.stage}`,
        partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // China mode: Secrets Manager for RS256 key pair
      const authKeysSecret = new secretsmanager.Secret(this, 'AuthKeysSecret', {
        secretName: `openclaw/${config.stage}/admin/auth-keys`,
        description: 'RS256 key pair for Auth Service JWT signing',
      });

      // China mode: Auth Service ECS Fargate
      const authExecRole = new iam.Role(this, 'AuthExecRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
      });

      const authTaskDef = new ecs.FargateTaskDefinition(this, 'AuthTaskDef', {
        family: `openclaw-auth-${config.stage}`,
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: authExecRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      // Grant Auth Service task role access to DynamoDB and Secrets Manager
      authUsersTable.grantReadWriteData(authTaskDef.taskRole);
      authKeysSecret.grantRead(authTaskDef.taskRole);

      const authLogGroup = new logs.LogGroup(this, 'AuthServiceLg', {
        logGroupName: `/openclaw/${config.stage}/auth-service`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      authTaskDef.addContainer('auth-service', {
        image: ecs.ContainerImage.fromRegistry(
          `${ecrDomain(this.account, this.region)}/${config.ecrRepoPrefix || 'openclaw'}-auth:latest`,
        ),
        portMappings: [{ containerPort: 3000 }],
        environment: {
          AUTH_USERS_TABLE: authUsersTable.tableName,
          AUTH_KEYS_SECRET: authKeysSecret.secretName,
          STAGE: config.stage,
        },
        logging: ecs.LogDrivers.awsLogs({ logGroup: authLogGroup, streamPrefix: 'auth' }),
        healthCheck: {
          command: ['CMD-SHELL', 'node -e "const h=require(\'http\');h.get(\'http://localhost:3000/health\',(r)=>{process.exit(r.statusCode===200?0:1)}).on(\'error\',()=>process.exit(1))"'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          startPeriod: cdk.Duration.seconds(60),
          retries: 3,
        },
      });

      // Auth Service security group
      const authSg = new ec2.SecurityGroup(this, 'AuthServiceSg', {
        vpc,
        description: 'Auth Service ECS Fargate tasks',
        allowAllOutbound: true, // Needs access to VPC Endpoints (ECR, Logs, Secrets Manager)
      });

      // Allow auth service to reach VPC Endpoints (ECR, Logs, etc.)
      // Use L1 CfnSecurityGroupIngress to avoid cross-stack cyclic reference.
      if (props.vpcEndpointSecurityGroup) {
        new ec2.CfnSecurityGroupIngress(this, 'AuthToVpceIngress', {
          groupId: props.vpcEndpointSecurityGroup.securityGroupId,
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          sourceSecurityGroupId: authSg.securityGroupId,
          description: 'Auth Service to VPC Endpoints',
        });
      }

      // Internal ALB for Auth Service
      const authAlbSg = new ec2.SecurityGroup(this, 'AuthAlbSg', {
        vpc,
        description: 'Internal ALB for Auth Service',
        allowAllOutbound: false,
      });
      authAlbSg.addEgressRule(authSg, ec2.Port.tcp(3000), 'ALB to Auth Service');
      authSg.addIngressRule(authAlbSg, ec2.Port.tcp(3000), 'ALB to Auth Service');
      // Allow Admin Lambda (and any VPC resource) to reach Auth ALB on port 80
      authAlbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), 'VPC to Auth ALB');

      const authAlb = new elbv2.ApplicationLoadBalancer(this, 'AuthAlb', {
        vpc,
        internetFacing: false,
        securityGroup: authAlbSg,
        vpcSubnets: { subnets: privateSubnets },
      });

      const authListener = authAlb.addListener('AuthListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      });

      // Auth Service ECS Fargate Service (2 replicas)
      const authService = new ecs.FargateService(this, 'AuthService', {
        serviceName: `openclaw-auth-${config.stage}`,
        cluster: ecsCluster,
        taskDefinition: authTaskDef,
        desiredCount: 2,
        vpcSubnets: { subnets: privateSubnets },
        securityGroups: [authSg],
        assignPublicIp: false,
      });

      authListener.addTargets('AuthTarget', {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [authService],
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
        },
      });

      lambdaAuthEnv.JWKS_URI = `http://${authAlb.loadBalancerDnsName}/auth/.well-known/jwks.json`;
      lambdaAuthEnv.AUTH_USERS_TABLE = authUsersTable.tableName;

      new cdk.CfnOutput(this, 'AuthAlbDns', { value: authAlb.loadBalancerDnsName });
      new cdk.CfnOutput(this, 'AuthUsersTableName', { value: authUsersTable.tableName });
    }

    // ── Lambda Security Group (no 0.0.0.0/0 inbound) ──
    const lambdaSg = new ec2.SecurityGroup(this, 'AdminLambdaSg', {
      vpc,
      description: 'Admin API Lambda - no public inbound',
      // Allow all outbound so Lambda can reach:
      // - DynamoDB, Secrets Manager, ECS via VPC Endpoints (VPC CIDR)
      // - Cognito JWKS endpoint via NAT Gateway (public internet)
      allowAllOutbound: true,
    });

    // ── Lambda IAM Role ──
    const regionShort = regionShortName(config.region || 'ap-northeast-2');
    const lambdaRole = new iam.Role(this, 'AdminLambdaRole', {
      roleName: `openclaw-admin-api-${config.stage}-${regionShort}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // DynamoDB read/write on Users, Providers, Audit Logs tables
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        usersTable.tableArn,
        `${usersTable.tableArn}/index/*`,
        providersTable.tableArn,
        `${providersTable.tableArn}/index/*`,
        auditLogsTable.tableArn,
        `${auditLogsTable.tableArn}/index/*`,
      ],
    }));

    // Secrets Manager read/write
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:CreateSecret',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        `arn:${partition}:secretsmanager:${this.region}:${this.account}:secret:openclaw/${config.stage}/*`,
      ],
    }));

    // ECS RunTask, StopTask, DescribeTasks, ListTasks
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:RunTask',
        'ecs:StopTask',
        'ecs:DescribeTasks',
        'ecs:ListTasks',
        'ecs:TagResource',
      ],
      resources: ['*'],
    }));

    // SSM Parameter Store read
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:${partition}:ssm:${this.region}:${this.account}:parameter/openclaw/${config.stage}/*`,
      ],
    }));

    // iam:PassRole for ECS task roles
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        `arn:${partition}:iam::${this.account}:role/openclaw-base-${config.stage}-${regionShort}`,
        `arn:${partition}:iam::${this.account}:role/openclaw-exec-${config.stage}-${regionShort}`,
      ],
    }));

    // Bedrock InvokeModel for provider connectivity testing
    // Bedrock is not available in China regions — skip these permissions there.
    if (deploymentMode !== 'china') {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:${partition}:bedrock:*::foundation-model/*`,
          `arn:${partition}:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }));
    }

    // ── Admin API Lambda (Fastify, ARM64, 512MB, 30s timeout, VPC) ──
    const adminLambda = new lambda.Function(this, 'AdminApiLambda', {
      functionName: `openclaw-admin-api-${config.stage}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../admin-api/dist', {
        exclude: ['node_modules/.cache'],
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaSg],
      role: lambdaRole,
      environment: {
        STAGE: config.stage,
        USERS_TABLE: usersTable.tableName,
        PROVIDERS_TABLE: providersTable.tableName,
        AUDIT_LOGS_TABLE: auditLogsTable.tableName,
        ECS_CLUSTER: ecsCluster.clusterName,
        ECS_TASK_DEFINITION: `openclaw-${config.stage}`,
        ECS_SUBNETS: privateSubnets.map(s => s.subnetId).join(','),
        ECS_SECURITY_GROUPS: taskSecurityGroup.securityGroupId,
        DATA_BUCKET: `openclaw-data-${config.stage}-${config.region || 'ap-northeast-2'}-${this.account}`,
        INTERNAL_ALB_URL: props.internalAlbDns ? `http://${props.internalAlbDns}:443` : '',
        ...lambdaAuthEnv,
      },
    });

    // ── API Gateway (REST type) ──
    this.apiGateway = new apigateway.RestApi(this, 'AdminApi', {
      restApiName: `openclaw-admin-api-${config.stage}`,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: config.stage },
    });

    // Proxy all /api/* requests to Lambda
    const apiResource = this.apiGateway.root.addResource('api');
    const apiProxy = apiResource.addProxy({
      defaultIntegration: new apigateway.LambdaIntegration(adminLambda),
      anyMethod: true,
    });

    // ── S3 Bucket for Admin Console SPA static assets ──
    this.consoleBucket = new s3.Bucket(this, 'ConsoleBucket', {
      bucketName: `openclaw-admin-console-${config.stage}-${config.region || 'ap-northeast-2'}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create OAI here (same stack as bucket) so we can grant read access without cross-stack cycles.
    // CdnStack will receive this OAI and use it for the /console/* CloudFront behavior.
    this.consoleOai = new cloudfront.OriginAccessIdentity(this, 'ConsoleOAI', {
      comment: `OAI for OpenClaw ${config.stage} admin console`,
    });
    this.consoleBucket.grantRead(this.consoleOai);

    // ── Deploy web-console build artifacts + runtime config to S3 ──
    // The runtime config (config.json) is generated by CDK with the actual
    // Cognito User Pool ID and Client ID, so the frontend build does NOT
    // need these values at build time. Just run `npm run build` without env vars.
    const runtimeConfig: Record<string, string> = {
      authMode: deploymentMode,
      apiBaseUrl: '',
    };

    if (deploymentMode === 'global') {
      runtimeConfig.cognitoUserPoolId = lambdaAuthEnv.COGNITO_USER_POOL_ID ?? '';
      runtimeConfig.cognitoClientId = lambdaAuthEnv.COGNITO_CLIENT_ID ?? '';
    } else {
      runtimeConfig.jwksUri = lambdaAuthEnv.JWKS_URI ?? '';
    }

    new s3deploy.BucketDeployment(this, 'ConsoleDeployment', {
      sources: [
        s3deploy.Source.asset('../web-console/dist'),
        s3deploy.Source.jsonData('config.json', runtimeConfig),
      ],
      destinationBucket: this.consoleBucket,
      destinationKeyPrefix: 'console/',
    });

    // ── Outputs ──
    new cdk.CfnOutput(this, 'AdminApiEndpoint', { value: this.apiGateway.url });
    new cdk.CfnOutput(this, 'ConsoleBucketName', { value: this.consoleBucket.bucketName });
    new cdk.CfnOutput(this, 'AdminLambdaArn', { value: adminLambda.functionArn });
  }
}
