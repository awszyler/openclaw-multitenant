import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';
import { regionShortName } from '../config';

export interface SecurityStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly dataBucket: s3.IBucket;
  readonly usersTable: dynamodb.ITable;
}

export class SecurityStack extends cdk.Stack {
  public readonly taskBaseRole: iam.Role;
  public readonly taskScopedRole: iam.Role;
  public readonly taskExecutionRole: iam.Role;
  public readonly proxyRole: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    const { config, dataBucket, usersTable } = props;
    const p = config.partition || 'aws';
    const ecsPrincipal = new iam.ServicePrincipal('ecs-tasks.amazonaws.com');
    const isChina = (config.deploymentMode || 'global') === 'china';

    const regionShort = regionShortName(config.region || 'ap-northeast-2');

    // Execution Role: standard ECS task execution + secrets read for ECS secrets injection
    this.taskExecutionRole = new iam.Role(this, 'ExecRole', {
      roleName: `openclaw-exec-${config.stage}-${regionShort}`,
      assumedBy: ecsPrincipal,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    this.taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:${p}:secretsmanager:${this.region}:${this.account}:secret:openclaw/${config.stage}/*`],
    }));

    // Base Role: ONLY sts:AssumeRole + logs. NO secretsmanager.
    this.taskBaseRole = new iam.Role(this, 'BaseRole', {
      roleName: `openclaw-base-${config.stage}-${regionShort}`,
      assumedBy: ecsPrincipal,
    });

    // Scoped Role: assumed by Base via STS with ABAC tags
    this.taskScopedRole = new iam.Role(this, 'ScopedRole', {
      roleName: `openclaw-scoped-${config.stage}-${regionShort}`,
      assumedBy: new iam.ArnPrincipal(this.taskBaseRole.roleArn),
    });
    this.taskScopedRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(this.taskBaseRole.roleArn)],
        actions: ['sts:TagSession'],
      }),
    );

    // Base → can assume Scoped + logs only
    this.taskBaseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.taskScopedRole.roleArn],
    }));
    this.taskBaseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${p}:logs:*:${this.account}:log-group:/openclaw/${config.stage}/*`],
    }));

    // Bedrock direct invocation for users whose provider_type='bedrock'.
    // Bedrock is not available in China regions — skip these permissions there.
    if (!isChina) {
      this.taskBaseRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: ['*'],
      }));
    }

    // Proxy Role: for credential proxy sidecar — secretsmanager only
    this.proxyRole = new iam.Role(this, 'ProxyRole', {
      roleName: `openclaw-proxy-${config.stage}-${regionShort}`,
      assumedBy: ecsPrincipal,
    });
    this.proxyRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:${p}:secretsmanager:${this.region}:${this.account}:secret:openclaw/${config.stage}/*`],
    }));

    // Scoped → S3 ABAC on ${aws:PrincipalTag/userId}/*
    this.taskScopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/*`],
    }));
    this.taskScopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [dataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': '${aws:PrincipalTag/userId}/*' } },
    }));

    // Scoped → DynamoDB ABAC on usersTable with LeadingKeys
    this.taskScopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [usersTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['${aws:PrincipalTag/userId}'] } },
    }));

    new cdk.CfnOutput(this, 'BaseRoleArn', { value: this.taskBaseRole.roleArn });
    new cdk.CfnOutput(this, 'ScopedRoleArn', { value: this.taskScopedRole.roleArn });
    new cdk.CfnOutput(this, 'ProxyRoleArn', { value: this.proxyRole.roleArn });
  }
}
