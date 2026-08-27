import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';

export interface BedrockLogsStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
}

/**
 * Configures account-level Bedrock Model Invocation Logging to CloudWatch.
 *
 * Bedrock invocation logging is a PutModelInvocationLoggingConfiguration call
 * — not a first-class CFN resource — so it's wrapped in an AwsCustomResource.
 * Scope: single setting per account+region. If multiple stacks try to set it,
 * the last one wins; we accept that since the target here is uniform stage
 * configuration.
 *
 * Logs: text prompt + response bodies in /openclaw/<stage>/bedrock-invocations.
 * Image/embedding data is omitted to keep logs bounded.
 */
export class BedrockLogsStack extends cdk.Stack {
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: BedrockLogsStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.logGroup = new logs.LogGroup(this, 'BedrockInvocationLg', {
      logGroupName: `/openclaw/${config.stage}/bedrock-invocations`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role that Bedrock assumes to write to the log group.
    const bedrockLogsRole = new iam.Role(this, 'BedrockLogsRole', {
      roleName: `openclaw-bedrock-logs-${config.stage}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    });
    bedrockLogsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
    }));

    const configPayload = {
      loggingConfig: {
        cloudWatchConfig: {
          logGroupName: this.logGroup.logGroupName,
          roleArn: bedrockLogsRole.roleArn,
        },
        textDataDeliveryEnabled: true,
        imageDataDeliveryEnabled: false,
        embeddingDataDeliveryEnabled: false,
      },
    };

    new AwsCustomResource(this, 'EnableBedrockLogging', {
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: configPayload,
        physicalResourceId: PhysicalResourceId.of(`bedrock-logging-${config.stage}`),
      },
      onDelete: {
        service: 'Bedrock',
        action: 'deleteModelInvocationLoggingConfiguration',
        parameters: {},
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
            'bedrock:GetModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLogsRole.roleArn],
          conditions: {
            StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    new cdk.CfnOutput(this, 'BedrockLogGroupName', { value: this.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'BedrockLogsRoleArn', { value: bedrockLogsRole.roleArn });
  }
}
