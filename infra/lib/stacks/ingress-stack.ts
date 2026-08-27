import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';

export interface IngressStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly usersTable: dynamodb.ITable;
  readonly ecsCluster: ecs.ICluster;
  readonly cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  readonly taskSecurityGroup: ec2.SecurityGroup;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
}

export class IngressStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: IngressStackProps) {
    super(scope, id, props);
    const { config, usersTable, ecsCluster, vpc, privateSubnets, taskSecurityGroup } = props;

    // Lambda SG — no 0.0.0.0 anywhere
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Router Lambda',
      allowAllOutbound: false,
    });
    // Lambda → VPCE for DynamoDB/ECS API calls (via gateway/interface endpoints)
    lambdaSg.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'Lambda to VPC CIDR for endpoints');

    const routerFn = new lambda.Function(this, 'Router', {
      functionName: `openclaw-router-${config.stage}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(ROUTER_CODE),
      timeout: cdk.Duration.seconds(60),
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaSg],
      environment: {
        USER_TASKS_TABLE: usersTable.tableName,
        ECS_CLUSTER: ecsCluster.clusterName,
        STAGE: config.stage,
      },
    });

    usersTable.grantReadWriteData(routerFn);
    routerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:DescribeTasks'],
      resources: ['*'],
    }));
    const partition = config.partition || 'aws';

    routerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [
        `arn:${partition}:iam::${this.account}:role/openclaw-base-${config.stage}`,
        `arn:${partition}:iam::${this.account}:role/openclaw-exec-${config.stage}`,
      ],
    }));

    // API Gateway (regional, no public SG needed — API GW is managed service)
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `openclaw-api-${config.stage}`,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: config.stage },
    });

    const webhook = this.api.root.addResource('webhook');
    webhook.addResource('{channel}').addMethod('POST', new apigateway.LambdaIntegration(routerFn));

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.url });
  }
}

const ROUTER_CODE = `
import json, os, time, boto3

ecs = boto3.client('ecs')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['USER_TASKS_TABLE'])
CLUSTER = os.environ['ECS_CLUSTER']
STAGE = os.environ['STAGE']

def handler(event, context):
    body = json.loads(event.get('body') or '{}')
    user_id = body.get('user_id', 'unknown')

    record = table.get_item(Key={'user_id': user_id}).get('Item')
    if record and record.get('status') == 'RUNNING':
        return {'statusCode': 200, 'body': json.dumps({'action': 'forwarded', 'user_id': user_id})}

    skill_group = record.get('skill_group', 'general') if record else 'general'
    task_def = f'openclaw-{STAGE}-{skill_group}'

    try:
        resp = ecs.run_task(
            cluster=CLUSTER,
            taskDefinition=task_def,
            launchType='FARGATE',
            networkConfiguration={'awsvpcConfiguration': {'subnets': [], 'assignPublicIp': 'DISABLED'}},
            overrides={'containerOverrides': [{'name': 'openclaw', 'environment': [{'name': 'OPENCLAW_USER_ID', 'value': user_id}]}]},
            enableExecuteCommand=False,
        )
        task_arn = resp['tasks'][0]['taskArn']
        table.put_item(Item={'user_id': user_id, 'task_arn': task_arn, 'skill_group': skill_group, 'status': 'STARTING', 'started_at': int(time.time()), 'ttl': int(time.time()) + 86400})
        return {'statusCode': 202, 'body': json.dumps({'action': 'starting', 'task_arn': task_arn})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
`;
