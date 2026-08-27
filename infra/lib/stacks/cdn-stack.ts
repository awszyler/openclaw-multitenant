import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';

export interface CdnStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly apiGateway: apigateway.RestApi;
  /** Admin API Gateway (optional — only present when AdminStack is deployed) */
  readonly adminApiGateway?: apigateway.RestApi;
  /** S3 bucket name hosting the Admin Console SPA (string to avoid cross-stack cycles) */
  readonly consoleBucketName?: string;
  /** OAI for the console bucket (created in AdminStack to avoid cross-stack cycles) */
  readonly consoleOai?: cloudfront.OriginAccessIdentity;
}

export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);
    const { config, apiGateway, adminApiGateway, consoleBucketName, consoleOai } = props;

    const deploymentMode = config.deploymentMode || 'global';
    const isChina = deploymentMode === 'china';

    // ── Ingress API Gateway origin (existing default behavior) ──
    const ingressApiDomain = `${apiGateway.restApiId}.execute-api.${this.region}.amazonaws.com`;

    // ── Additional behaviors ──
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

    // ── /console/* → S3 Origin (Admin Console SPA) ──
    if (consoleBucketName && consoleOai) {
      // Import bucket by name to avoid cross-stack cyclic references.
      // The OAI and bucket policy are managed in AdminStack.
      const consoleBucket = s3.Bucket.fromBucketName(this, 'ConsoleBucketRef', consoleBucketName);

      const consoleOrigin = new origins.S3Origin(consoleBucket, {
        originAccessIdentity: consoleOai,
        originPath: '',
      });

      const consoleBehavior: cloudfront.BehaviorOptions = {
        origin: consoleOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        ...(isChina ? {} : { cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      };

      additionalBehaviors['/console/*'] = consoleBehavior;
    }

    // ── /api/* → Admin API Gateway Origin ──
    if (adminApiGateway) {
      const adminApiDomain = `${adminApiGateway.restApiId}.execute-api.${this.region}.amazonaws.com`;

      const adminApiOrigin = new origins.HttpOrigin(adminApiDomain, {
        originPath: `/${config.stage}`,
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      });

      const apiBehavior: cloudfront.BehaviorOptions = isChina
        ? {
            origin: adminApiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            compress: true,
          }
        : {
            origin: adminApiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          };

      additionalBehaviors['/api/*'] = apiBehavior;
    }

    // ── Default behavior: Ingress API Gateway (existing) ──
    const defaultBehavior: cloudfront.BehaviorOptions = isChina
      ? {
          origin: new origins.HttpOrigin(ingressApiDomain, {
            originPath: `/${config.stage}`,
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: true,
        }
      : {
          origin: new origins.HttpOrigin(ingressApiDomain, {
            originPath: `/${config.stage}`,
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        };

    // ── Custom error responses for SPA routing fallback ──
    const errorResponses: cloudfront.ErrorResponse[] = consoleBucketName
      ? [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/console/index.html',
            ttl: cdk.Duration.seconds(0),
          },
        ]
      : [];

    // ── Distribution configuration ──
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `OpenClaw ${config.stage} - public ingress via CloudFront`,
      defaultBehavior,
      additionalBehaviors,
      errorResponses,
      // China region only supports PriceClass_All
      priceClass: isChina ? cloudfront.PriceClass.PRICE_CLASS_ALL : cloudfront.PriceClass.PRICE_CLASS_200,
      enabled: true,
      // China: IPv4 only, custom domain
      ...(isChina && {
        enableIpv6: false,
        ...(config.customDomain ? { domainNames: [config.customDomain] } : {}),
      }),
    });

    // ── China region: IAM certificate override (L1 escape hatch) ──
    if (isChina) {
      const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution;

      // China CloudFront does not support CachePolicyId or OriginRequestPolicyId.
      // Remove them from all cache behaviors and use legacy ForwardedValues instead.
      cfnDistribution.addPropertyOverride(
        'DistributionConfig.DefaultCacheBehavior.CachePolicyId',
        undefined,
      );
      cfnDistribution.addPropertyDeletionOverride(
        'DistributionConfig.DefaultCacheBehavior.CachePolicyId',
      );
      cfnDistribution.addPropertyDeletionOverride(
        'DistributionConfig.DefaultCacheBehavior.OriginRequestPolicyId',
      );
      // Add legacy ForwardedValues for default behavior (forward all for API proxy)
      cfnDistribution.addPropertyOverride(
        'DistributionConfig.DefaultCacheBehavior.ForwardedValues',
        { QueryString: true, Headers: ['*'] },
      );

      // Fix additional behaviors (CacheBehaviors array)
      const cacheBehaviors = cfnDistribution.distributionConfig as any;
      // We'll override each CacheBehavior entry
      const behaviorKeys = Object.keys(additionalBehaviors);
      for (let i = 0; i < behaviorKeys.length; i++) {
        cfnDistribution.addPropertyDeletionOverride(
          `DistributionConfig.CacheBehaviors.${i}.CachePolicyId`,
        );
        cfnDistribution.addPropertyDeletionOverride(
          `DistributionConfig.CacheBehaviors.${i}.OriginRequestPolicyId`,
        );
        // Add legacy ForwardedValues
        const path = behaviorKeys[i];
        if (path === '/console/*') {
          // Static assets: forward nothing, cache everything
          cfnDistribution.addPropertyOverride(
            `DistributionConfig.CacheBehaviors.${i}.ForwardedValues`,
            { QueryString: false },
          );
        } else {
          // API: forward all
          cfnDistribution.addPropertyOverride(
            `DistributionConfig.CacheBehaviors.${i}.ForwardedValues`,
            { QueryString: true, Headers: ['*'] },
          );
        }
      }

      // Custom domain + IAM certificate
      if (config.customDomain && config.iamCertificateId) {
        cfnDistribution.addPropertyOverride(
          'DistributionConfig.ViewerCertificate',
          {
            IamCertificateId: config.iamCertificateId,
            SslSupportMethod: 'sni-only',
            MinimumProtocolVersion: 'TLSv1.2_2021',
          },
        );
      }
    }

    // ── Outputs ──
    new cdk.CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `https://${this.distribution.distributionDomainName}/webhook/{channel}`,
    });
    if (consoleBucketName) {
      new cdk.CfnOutput(this, 'ConsoleUrl', {
        value: `https://${config.customDomain || this.distribution.distributionDomainName}/console/`,
      });
    }
  }
}
