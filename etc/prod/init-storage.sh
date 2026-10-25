#!/bin/sh
set -eu
umask 077

mcli mb --ignore-existing "storage/${MINIO_BUCKET}"
mcli admin user add storage "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"

# Give the backend access only to its attachment bucket, not storage administration.
cat > /tmp/attachments-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${MINIO_BUCKET}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::${MINIO_BUCKET}/*"]
    }
  ]
}
EOF
mcli admin policy create storage msgnr-attachments /tmp/attachments-policy.json
mcli admin policy attach storage msgnr-attachments --user "${MINIO_ACCESS_KEY}"
echo 'Attachment bucket and backend storage credentials configured'
