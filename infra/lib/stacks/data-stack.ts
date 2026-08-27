import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';

export interface DataStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
}

export class DataStack extends cdk.Stack {
  public readonly dataBucket: s3.IBucket;
  public readonly usersTable: dynamodb.Table;
  public readonly imagesTable: dynamodb.Table;
  public readonly providersTable: dynamodb.Table;
  public readonly auditLogsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.dataBucket = s3.Bucket.fromBucketName(this, 'Bucket',
      config.dataBucketName || `openclaw-data-${config.stage}-${config.region || 'ap-northeast-2'}-${this.account}`,
    );

    this.usersTable = new dynamodb.Table(this, 'Users', {
      tableName: `openclaw-users-${config.stage}`,
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    this.imagesTable = new dynamodb.Table(this, 'Images', {
      tableName: `openclaw-images-${config.stage}`,
      partitionKey: { name: 'skill_group', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Providers Table — stores model provider configurations
    this.providersTable = new dynamodb.Table(this, 'Providers', {
      tableName: `openclaw-providers-${config.stage}`,
      partitionKey: { name: 'provider_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.providersTable.addGlobalSecondaryIndex({
      indexName: 'litellm_model_name-index',
      partitionKey: { name: 'litellm_model_name', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Audit Logs Table — stores admin operation audit logs with 90-day TTL
    this.auditLogsTable = new dynamodb.Table(this, 'AuditLogs', {
      tableName: `openclaw-audit-logs-${config.stage}`,
      partitionKey: { name: 'log_date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp#log_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expire_at',
    });

    new cdk.CfnOutput(this, 'BucketName', { value: this.dataBucket.bucketName });
    new cdk.CfnOutput(this, 'UsersTableName', { value: this.usersTable.tableName });
    new cdk.CfnOutput(this, 'ImagesTableName', { value: this.imagesTable.tableName });
    new cdk.CfnOutput(this, 'ProvidersTableName', { value: this.providersTable.tableName });
    new cdk.CfnOutput(this, 'AuditLogsTableName', { value: this.auditLogsTable.tableName });
  }
}
