/*
 * Copyright 2024-2026 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package main

import (
	"encoding/json"
	"testing"
)

func TestParseConn_PrefersPluginProviderInHostLifecyclePayload(t *testing.T) {
	params := json.RawMessage(`{
		"provider": {
			"id": "com.object.browser.connection",
			"databaseType": "oss"
		},
		"connection": {
			"name": "S3 compatible",
			"external_config": {
				"provider": "s3",
				"access_key_id": "AK",
				"endpoint": "https://s3.example.com",
				"region": "us-east-1",
				"path_style": true,
				"bucket": "example-bucket"
			},
			"connection_secrets": {
				"access_key_secret": "SK"
			}
		}
	}`)

	config, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn failed: %v", err)
	}
	if config.Provider.String() != ProviderS3 {
		t.Fatalf("provider = %q, want %q", config.Provider.String(), ProviderS3)
	}
	if !config.PathStyle {
		t.Fatal("path_style was not preserved")
	}
	if config.Bucket != "example-bucket" {
		t.Fatalf("bucket = %q, want %q", config.Bucket, "example-bucket")
	}
}

func TestParseConn_FlatS3PayloadKeepsTopLevelProvider(t *testing.T) {
	params := json.RawMessage(`{
		"provider": "s3",
		"accessKeyId": "AK",
		"accessKeySecret": "SK",
		"endpoint": "https://s3.example.com",
		"pathStyle": true,
		"bucket": "example-bucket"
	}`)

	config, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn failed: %v", err)
	}
	if config.Provider.String() != ProviderS3 {
		t.Fatalf("provider = %q, want %q", config.Provider.String(), ProviderS3)
	}
	if !config.PathStyle {
		t.Fatal("pathStyle was not preserved")
	}
}
