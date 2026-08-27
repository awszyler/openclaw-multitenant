#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { ProxyStack } from '../lib/stacks/proxy-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { IngressStack } from '../lib/stacks/ingress-stack';
import { CdnStack } from '../lib/stacks/cdn-stack';
import { AdminStack } from '../lib/stacks/admin-stack';
import { BedrockLogsStack } from '../lib/stacks/bedrock-logs-stack';
import type { OpenClawConfig } from '../lib/config';
import { DEFAULT_CONFIG, resolvePartition, resolveDeploymentMode } from '../lib/config';

const app = new cdk.App();

const stage = app.node.tryGetContext('stage') || DEFAULT_CONFIG.stage!;
const region = app.node.tryGetContext('region') || DEFAULT_CONFIG.region!;
const config: OpenClawConfig = {
  stage,
  region,
  partition: resolvePartition(region),
  vpcId: app.node.tryGetContext('vpcId'),
  privateSubnetIds: app.node.tryGetContext('privateSubnetIds'),
  litellmEndpoint: app.node.tryGetContext('litellmEndpoint'),
  dataBucketName: app.node.tryGetContext('dataBucketName'),
  ecsClusterName: app.node.tryGetContext('ecsClusterName'),
  skillGroups: app.node.tryGetContext('skillGroups')?.split(',') || DEFAULT_CONFIG.skillGroups!,
  enableWaf: app.node.tryGetContext('enableWaf') ?? DEFAULT_CONFIG.enableWaf,
  dynamoDbBillingMode: DEFAULT_CONFIG.dynamoDbBillingMode as 'PAY_PER_REQUEST',
  ecrRepoPrefix: app.node.tryGetContext('ecrRepoPrefix') || DEFAULT_CONFIG.ecrRepoPrefix,
  deploymentMode: app.node.tryGetContext('deploymentMode') || resolveDeploymentMode(region),
  customDomain: app.node.tryGetContext('customDomain'),
  icpDomain: app.node.tryGetContext('icpDomain'),
  iamCertificateId: app.node.tryGetContext('iamCertificateId'),
  adminEmail: app.node.tryGetContext('adminEmail'),
};

const env: cdk.Environment = {
  region: config.region,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const prefix = `openclaw-${stage}`;

const networkStack = new NetworkStack(app, `${prefix}-network`, { env, config });

// Bedrock is not available in China regions — skip invocation logging there.
const isChina = config.deploymentMode === 'china';
const bedrockLogsStack = isChina
  ? undefined
  : new BedrockLogsStack(app, `${prefix}-bedrock-logs`, { env, config });

const dataStack = new DataStack(app, `${prefix}-data`, { env, config });
dataStack.addDependency(networkStack);

const securityStack = new SecurityStack(app, `${prefix}-security`, {
  env, config,
  dataBucket: dataStack.dataBucket,
  usersTable: dataStack.usersTable,
});
securityStack.addDependency(dataStack);

const proxyStack = new ProxyStack(app, `${prefix}-proxy`, {
  env, config,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  taskSecurityGroup: networkStack.taskSecurityGroup,
  usersTable: dataStack.usersTable,
  providersTable: dataStack.providersTable,
});
proxyStack.addDependency(securityStack);

const computeStack = new ComputeStack(app, `${prefix}-compute`, {
  env, config,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  taskSecurityGroup: networkStack.taskSecurityGroup,
  dataBucketName: dataStack.dataBucket.bucketName,
  internalAlbDns: proxyStack.internalAlb.loadBalancerDnsName,
});
computeStack.addDependency(proxyStack);

const adminStack = new AdminStack(app, `${prefix}-admin`, {
  env, config,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  usersTable: dataStack.usersTable,
  providersTable: dataStack.providersTable,
  auditLogsTable: dataStack.auditLogsTable,
  ecsCluster: computeStack.ecsCluster,
  taskSecurityGroup: networkStack.taskSecurityGroup,
  vpcEndpointSecurityGroup: networkStack.vpcEndpointSecurityGroup,
  internalAlbDns: proxyStack.internalAlb.loadBalancerDnsName,
});
adminStack.addDependency(dataStack);
adminStack.addDependency(computeStack);
adminStack.addDependency(proxyStack);

const ingressStack = new IngressStack(app, `${prefix}-ingress`, {
  env, config,
  usersTable: dataStack.usersTable,
  ecsCluster: computeStack.ecsCluster,
  cloudMapNamespace: computeStack.cloudMapNamespace,
  taskSecurityGroup: networkStack.taskSecurityGroup,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
});
ingressStack.addDependency(computeStack);

const cdnStack = new CdnStack(app, `${prefix}-cdn`, {
  env, config,
  apiGateway: ingressStack.api,
  adminApiGateway: adminStack.apiGateway,
  consoleBucketName: adminStack.consoleBucket.bucketName,
  consoleOai: adminStack.consoleOai,
});
cdnStack.addDependency(ingressStack);
cdnStack.addDependency(adminStack);

// Silence unused-import TS error while keeping the stack registered with the App.
void bedrockLogsStack;
void BedrockLogsStack;

app.synth();
