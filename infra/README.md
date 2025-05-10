# PRXY AWS Deployment

This directory contains the infrastructure as code (IaC) setup using Pulumi to deploy the PRXY server to AWS.

## Overview

The deployment process:

1. Builds a Docker container for the PRXY server
2. Pushes the container to Amazon ECR
3. Provisions an EC2 instance using Pulumi
4. Deploys the container to the EC2 instance

## Infrastructure Components

- **VPC**: Dedicated VPC for the PRXY server
- **EC2 Instance**: t2.micro instance running the PRXY container
- **Security Group**: Allows traffic on port 3000 (PRXY) and 22 (SSH)
- **IAM Role**: Provides the EC2 instance with permissions to pull from ECR and access S3

## GitHub Actions Workflow

The GitHub Actions workflow automates the entire deployment process:

1. Builds and pushes the Docker image to ECR
2. Deploys the infrastructure using Pulumi
3. Stores environment variables in S3 for the EC2 instance to retrieve

## Prerequisites for Deployment

The following secrets must be configured in your GitHub repository:

- `AWS_ACCESS_KEY_ID`: AWS access key with permissions for ECR, EC2, S3, and IAM
- `AWS_SECRET_ACCESS_KEY`: Corresponding AWS secret key
- `PULUMI_ACCESS_TOKEN`: Access token for your Pulumi account
- `S3_BUCKET`: Name of the S3 bucket to store environment files
- `ALLOWED_API_KEYS`: Comma-separated list of API keys allowed to use the proxy

## Manual Deployment

If you need to deploy manually without GitHub Actions:

1. Build and push the Docker image to ECR

   ```bash
   docker build -t prxy .
   docker tag prxy:latest <your-ecr-repo-url>:latest
   docker push <your-ecr-repo-url>:latest
   ```

2. Set up Pulumi:

   ```bash
   cd infra
   npm install
   pulumi stack select dev --create
   pulumi config set aws:region us-east-1  # Or your preferred region
   pulumi config set ECR_REPO_URL <your-ecr-repo-url>
   pulumi config set S3_BUCKET <your-s3-bucket>
   ```

3. Create and upload the environment file:

   ```bash
   cat > prxy.env << EOL
   PORT=3000
   CLAUDE_API_URL=https://api.anthropic.com
   ALLOWED_API_KEYS=key1,key2,key3
   EOL
   aws s3 cp prxy.env s3://<your-s3-bucket>/prxy.env
   ```

4. Deploy with Pulumi:

   ```bash
   pulumi up
   ```

## Accessing the PRXY Server

After deployment, the PRXY server will be available at:

```
http://<EC2-Public-IP>:3000
```

The public IP address is output at the end of the Pulumi deployment.
