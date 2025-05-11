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
- **Security Group**: Allows traffic on port 3000 (PRXY) and restricts SSH access (port 22) to connections from within the VPC only
- **IAM Role**: Provides the EC2 instance with permissions to pull from ECR and access S3

## SSH Access Security

The deployment configures SSH access to be restricted to EC2 Instance Connect only:

1. The EC2 instance has EC2 Instance Connect package installed
2. Password authentication is disabled in SSH configuration
3. SSH port (22) is only accessible from within the VPC CIDR range
4. The IAM role has the EC2InstanceConnect policy attached

To connect to the instance, you must use the AWS Console's EC2 Instance Connect feature or the AWS CLI with EC2 Instance Connect credentials. This prevents direct SSH access using SSH keys and improves security by leveraging AWS IAM permissions and short-lived credentials.

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

## Connecting to the EC2 Instance

To connect to the EC2 instance, use EC2 Instance Connect from the AWS Console:

1. Go to the EC2 service in the AWS Console
2. Select the instance with the name "prxy"
3. Click "Connect" button
4. Choose "EC2 Instance Connect" tab
5. Click "Connect" button

Alternatively, you can use the AWS CLI to connect using EC2 Instance Connect:

```bash
aws ec2-instance-connect ssh --instance-id i-1234567890abcdef0 --os-user ubuntu
```

Note that direct SSH access with SSH keys is disabled for security reasons.
