"use strict";

import fs = require("fs");
import kubectlutility = require("utility-common/kubectlutility");
import path = require('path');
import tl = require('vsts-task-lib/task');
import yaml = require('js-yaml');
import * as utils from "./../utilities";
import { IExecSyncResult } from 'vsts-task-lib/toolrunner';
import { Kubectl, Resource } from "utility-common/kubectl-object-model";
import * as canaryDeploymentHelper from '../CanaryDeploymentHelper';
import * as KubernetesObjectUtility from '../KubernetesObjectUtility';

const TASK_INPUT_CANARY_PERCENTAGE = "percentage";
const TASK_INPUT_DEPLOYMENT_STRATEGY = "deploymentStrategy";
const CANARY_DEPLOYMENT_STRATEGY = "CANARY";

export async function deploy() {

    var files: string[] = tl.findMatch(tl.getVariable("System.DefaultWorkingDirectory") || process.cwd(), tl.getInput("manifests", true));

    if (files.length == 0) {
        throw (tl.loc("ManifestFileNotFound"));
    }

    let containers = tl.getDelimitedInput("containers", "\n");
    files = updateContainerImagesInConfigFiles(files, containers);

    let kubectl = new Kubectl(await utils.getKubectl(), tl.getInput("namespace", false));

    var deploymentStrategy = tl.getInput(TASK_INPUT_DEPLOYMENT_STRATEGY);
    let result;
    if (deploymentStrategy && deploymentStrategy.toUpperCase() === CANARY_DEPLOYMENT_STRATEGY){
        var canaryDeploymentOutput = canaryDeployment(files, kubectl);
        result = canaryDeploymentOutput.result;
        files = canaryDeploymentOutput.newFilePaths;
    }else {
        result = kubectl.apply(files);
    }
    utils.checkForErrors([result]);

    let rolloutStatusResults = [];
    let resourceTypes: Resource[] = KubernetesObjectUtility.getResources(files, recognizedWorkloadTypes);  
    resourceTypes.forEach(resource => {
        if (recognizedWorkloadTypesWithRolloutStatus.indexOf(resource.type.toLowerCase()) == -1){
        rolloutStatusResults.push(kubectl.checkRolloutStatus(resource.type, resource.name));
        }
    });
    utils.checkForErrors(rolloutStatusResults);

    let annotateResults: IExecSyncResult[] = [];
    var allPods = JSON.parse((kubectl.getAllPods()).stdout);
    annotateResults.push(kubectl.annotateFiles(files, utils.annotationsToAdd(), true));
    resourceTypes.forEach(resource => {
        if (resource.type.toUpperCase() != KubernetesObjectUtility.KubernetesWorkload.Pod.toUpperCase()){
            annotateChildPods(kubectl, resource.type, resource.name, allPods)
                .forEach(execResult => annotateResults.push(execResult));
        }
    });
    utils.checkForErrors(annotateResults, true);
}

function canaryDeployment(filePaths: string[], kubectl: Kubectl) {
    var newObjectsList = [];
    var percentage = parseInt(tl.getInput(TASK_INPUT_CANARY_PERCENTAGE));

    filePaths.forEach((filePath: string) => {  
    var fileContents = fs.readFileSync(filePath);
    yaml.safeLoadAll(fileContents, function (inputObject) {
            
        var name = inputObject.metadata.name;
        var kind = inputObject.kind;
        if (canaryDeploymentHelper.isDeploymentEntity(kind)){
            var existing_canary_object = canaryDeploymentHelper.fetchCanaryResource(kubectl, kind, name);

            if (!!existing_canary_object){
                throw new Error("Canary deployment already exists. Rejecting this deployment");
            }

            var canaryReplicaCount = canaryDeploymentHelper.calculateReplicaCountForCanary(inputObject, percentage);
            // Get stable object
            var stable_object = canaryDeploymentHelper.fetchResource(kubectl, kind, name);
            if (!stable_object ){
                // If stable object not found, create canary deployment.
                var newCanaryObject = canaryDeploymentHelper.getNewCanaryResource(inputObject, canaryReplicaCount);
                newObjectsList.push(newCanaryObject);
            } else {
                    // If canary object not found, create canary and baseline object.
                    var newCanaryObject = canaryDeploymentHelper.getNewCanaryResource(inputObject, canaryReplicaCount);
                    var newBaselineObject = canaryDeploymentHelper.getNewBaselineResource(stable_object, canaryReplicaCount);
                    newObjectsList.push(newCanaryObject);
                    newObjectsList.push(newBaselineObject);
                }
        } else {
            // Updating non deployment entity as it is.
            newObjectsList.push(inputObject);
        }});
    });

    return canaryDeploymentHelper.applyResource(kubectl, newObjectsList);;
}

function updateContainerImagesInConfigFiles(filePaths: string[], containers): string[] {
    if (containers != []) {
        let newFilePaths = [];
        const tempDirectory = utils.getTempDirectory();
        filePaths.forEach((filePath: string) => {
            var contents = fs.readFileSync(filePath).toString();
            containers.forEach((container: string) => {
                let imageName = container.split(":")[0] + ":";
                if (contents.indexOf(imageName) > 0) {
                    contents = replaceAllTokens(contents, imageName, container);
                }
            });

            let fileName = path.join(tempDirectory, path.basename(filePath));
            fs.writeFileSync(
                path.join(fileName),
                contents
            );

            newFilePaths.push(fileName);
        });

        return newFilePaths;
    }

    return filePaths;
}

function replaceAllTokens(currentString: string, replaceToken, replaceValue) {
    let i = currentString.indexOf(replaceToken);
    if (i < 0) {
        tl.debug(`No occurence of replacement token: ${replaceToken} found`);
        return currentString;
    }

    let newString = currentString.substring(0, i);
    let leftOverString = currentString.substring(i);
    newString += replaceValue + leftOverString.substring(Math.min(leftOverString.indexOf("\n"), leftOverString.indexOf("\"")));
    if (newString == currentString) {
        tl.debug(`All occurences replaced`);
        return newString;
    }
    return replaceAllTokens(newString, replaceToken, replaceValue);
}

var recognizedWorkloadTypes: string[] = ["deployment", "replicaset", "daemonset", "pod", "statefulset"];
var recognizedWorkloadTypesWithRolloutStatus: string[] = ["deployment", "daemonset", "statefulset"];