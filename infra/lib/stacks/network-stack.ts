import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fw from 'aws-cdk-lib/aws-networkfirewall';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';
import { resolveDeploymentMode } from '../config';

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
}

// Allowed outbound domains for channel plugins
const ALLOWED_DOMAINS = [
  '.work.weixin.qq.com',       // WeCom WS + API
  '.botframework.com',          // Teams Bot Framework
  'login.microsoftonline.com',  // Teams OAuth
  'graph.microsoft.com',        // Teams Graph API
  '.amazonaws.com',             // ECR pull + AWS APIs (filtered by SG to 443 only)
  'public.ecr.aws',             // Public ECR (aws-cli sidecar image)
  '.npmjs.org',                 // npm registry
  '.npmjs.com',                 // npm website
  '.cloudfront.net',            // LiteLLM via CloudFront
  '.githubusercontent.com',     // npm package tarballs
];

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly taskSecurityGroup: ec2.SecurityGroup;
  public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;
    const isChina = (config.deploymentMode || resolveDeploymentMode(config.region || '')) === 'china';

    // ── VPC: 3-tier (public + private + firewall) ──
    if (config.vpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: config.vpcId });
      this.privateSubnets = config.privateSubnetIds?.length
        ? config.privateSubnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(this, `S${i}`, sid))
        : this.vpc.privateSubnets;
    } else {
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
          { name: 'firewall', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
        ],
      });
      this.privateSubnets = this.vpc.privateSubnets;
    }

    // ── Security Groups ──
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: this.vpc,
      description: 'OpenClaw Fargate Tasks',
      allowAllOutbound: false,
    });

    this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpceSg', {
      vpc: this.vpc,
      description: 'VPC Endpoints',
      allowAllOutbound: false,
    });

    // Task → VPCE
    this.vpcEndpointSecurityGroup.addIngressRule(this.taskSecurityGroup, ec2.Port.tcp(443), 'Tasks to VPCE');
    this.taskSecurityGroup.addEgressRule(this.vpcEndpointSecurityGroup, ec2.Port.tcp(443), 'Task to VPCE');

    // Task → public internet via NAT Gateway (Network Firewall filters by domain)
    this.taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Task to NAT for public HTTPS',
    );

    // ── VPC Endpoints ──
    this.vpc.addGatewayEndpoint('S3Ep', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnets: this.privateSubnets }],
    });
    this.vpc.addGatewayEndpoint('DdbEp', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnets: this.privateSubnets }],
    });

    const interfaceEndpoints = [
      { id: 'StsEp', service: ec2.InterfaceVpcEndpointAwsService.STS },
      { id: 'SmEp', service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
      { id: 'LogsEp', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'EcrEp', service: ec2.InterfaceVpcEndpointAwsService.ECR },
      { id: 'EcrDkrEp', service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER },
      // Bedrock direct path: Tasks with provider_type=bedrock hit the
      // Runtime API here instead of going through the LiteLLM proxy.
      // Bedrock is not available in China regions — skip the endpoint there.
      ...(!isChina ? [{ id: 'BedrockRuntimeEp', service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME }] : []),
    ];

    for (const svc of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(svc.id, {
        service: svc.service,
        subnets: { subnets: this.privateSubnets },
        securityGroups: [this.vpcEndpointSecurityGroup],
        privateDnsEnabled: true,
      });
    }

    // ── AWS Network Firewall (domain whitelist) ──
    if (!config.vpcId) {
      const ruleGroup = new fw.CfnRuleGroup(this, 'DomainAllowRules', {
        ruleGroupName: `openclaw-${config.stage}-domain-allow`,
        type: 'STATEFUL',
        capacity: 100,
        ruleGroup: {
          statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
          rulesSource: {
            rulesSourceList: {
              targets: ALLOWED_DOMAINS,
              targetTypes: ['TLS_SNI', 'HTTP_HOST'],
              generatedRulesType: 'ALLOWLIST',
            },
          },
        },
      });

      const fwPolicy = new fw.CfnFirewallPolicy(this, 'FwPolicy', {
        firewallPolicyName: `openclaw-${config.stage}-fw-policy`,
        firewallPolicy: {
          statelessDefaultActions: ['aws:forward_to_sfe'],
          statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
          statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
          statefulDefaultActions: ['aws:drop_established'],
          statefulRuleGroupReferences: [{
            resourceArn: ruleGroup.attrRuleGroupArn,
            priority: 1,
          }],
        },
      });

      const firewallSubnets = this.vpc.isolatedSubnets;
      const firewall = new fw.CfnFirewall(this, 'Firewall', {
        firewallName: `openclaw-${config.stage}-fw`,
        firewallPolicyArn: fwPolicy.attrFirewallPolicyArn,
        vpcId: this.vpc.vpcId,
        subnetMappings: firewallSubnets.map(s => ({ subnetId: s.subnetId })),
      });

      new cdk.CfnOutput(this, 'FirewallId', { value: firewall.ref });
      new cdk.CfnOutput(this, 'AllowedDomains', { value: ALLOWED_DOMAINS.join(', ') });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'TaskSgId', { value: this.taskSecurityGroup.securityGroupId });
  }
}
