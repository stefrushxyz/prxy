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
- **Elastic IP**: Static IP address assigned to the EC2 instance
- **Security Group**: Allows traffic on port 3000 (PRXY) and port 22 (SSH) from any IP address
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
- `ALLOWED_API_KEYS`: Comma-separated list of API keys allowed to use the proxy

You can also configure these optional variables:

- `PROJECT_NAME`: Name for your project (default: 'prxy')
- `AWS_REGION`: AWS region to deploy to (default: 'us-east-1')
- `EC2_INSTANCE_TYPE`: EC2 instance type to use (default: 't3.micro')
- `UPDATE_INTERVAL`: Seconds between update checks (default: '10')
- `PORT`: Port to expose the server on (default: '3000')

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
   pulumi config set PROJECT_NAME prxy  # Or your preferred project name
   pulumi config set EC2_INSTANCE_TYPE t3.micro  # Or your preferred instance type
   pulumi config set UPDATE_INTERVAL "*/1 * * * *"  # Or your preferred cron schedule
   pulumi config set IMAGE_TAG latest
   ```

3. Create and upload the environment file:

   ```bash
   # S3 bucket will be named PROJECT_NAME-s3-env (e.g., prxy-s3-env)
   aws s3 mb s3://prxy-s3-env  # Replace prxy with your PROJECT_NAME if changed

   cat > prxy.env << EOL
   PORT=3000
   CLAUDE_API_URL=https://api.anthropic.com
   ALLOWED_API_KEYS=key1,key2,key3
   EOL
   aws s3 cp prxy.env s3://prxy-s3-env/prxy.env  # Replace prxy with your PROJECT_NAME if changed
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

## SSH Access

### Connecting to the EC2 Instance

The EC2 instance allows SSH access from any IP address. You can connect using standard SSH methods:

```bash
ssh -i your-key-pair.pem ubuntu@<EC2-Public-IP>
```

You can also use EC2 Instance Connect through the AWS Console or AWS CLI for convenience:

1. Through the AWS Console:

   - Go to the EC2 service
   - Select the instance
   - Click "Connect" button
   - Choose "EC2 Instance Connect" tab
   - Click "Connect" button

2. Using the AWS CLI:

   ```bash
   aws ec2-instance-connect ssh --instance-id i-01234567890abcdef --os-user ubuntu
   ```

### Docker Container Management

Once connected to the instance via SSH, you can manage the Docker container:

1. List running containers:

   ```bash
   docker ps
   ```

2. List all containers (including stopped ones):

   ```bash
   docker ps -a
   ```

3. View container logs:

   ```bash
   docker logs prxy
   ```

4. Follow container logs in real-time:

   ```bash
   docker logs -f prxy
   ```

5. Restart the container:

   ```bash
   docker restart prxy
   ```

6. View container details:

   ```bash
   docker inspect prxy
   ```

7. Check update logs:

   ```bash
   cat /home/ubuntu/prxy/update.log
   ```
