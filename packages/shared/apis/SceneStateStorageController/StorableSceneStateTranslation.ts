import { SceneStateDefinition } from 'scene-system/stateful-scene/SceneStateDefinition'
import { Component } from 'scene-system/stateful-scene/types'
import { uuid } from 'atomicHelpers/math'
import { CLASS_ID } from '@dcl/legacy-ecs'
import {
  BuilderAsset,
  BuilderComponent,
  BuilderEntity,
  BuilderManifest,
  BuilderScene,
  SerializedSceneState,
  UnityColor
} from './types'
import { BuilderServerAPIManager } from './BuilderServerAPIManager'
import { toHumanReadableType, fromHumanReadableType, camelize, getUniqueNameForGLTF } from './utils'
import { SceneTransformTranslator } from './SceneTransformTranslator'

const CURRENT_SCHEMA_VERSION = 1

export type StorableSceneState = {
  schemaVersion: number
  entities: StorableEntity[]
}

type StorableEntity = {
  id: string
  components: StorableComponent[]
}

type StorableComponent = {
  type: string
  value: any
}

export async function toBuilderFromStateDefinitionFormat(
  scene: SceneStateDefinition,
  builderManifest: BuilderManifest,
  builderApiManager: BuilderServerAPIManager,
  transfromTranslator: SceneTransformTranslator
): Promise<BuilderManifest> {
  const entities: Record<string, BuilderEntity> = {}
  const builderComponents: Record<string, BuilderComponent> = {}
  const gltfNames: string[] = []
  let nftCount = 0

  // Iterate every entity to get the components for builder
  for (const [entityId, components] of scene.getState().entries()) {
    const builderComponentsIds: string[] = []

    let entityName = entityId

    // Iterate the entity components to transform them to the builder format
    const mappedComponents = Array.from(components.entries()).map(([componentId, data]) => ({ componentId, data }))
    for (const component of mappedComponents) {
      // We generate a new uuid for the component since there is no uuid for components in the stateful scheme
      const newId = uuid()

      const componentType = toHumanReadableType(component.componentId)
      builderComponentsIds.push(newId)

      // This is a special case where we are assinging the builder url field for NFTs
      if (componentType === 'NFTShape') {
        component.data.url = component.data.src
        if (nftCount >= 1) {
          // This is the format that is used by builder
          entityName = 'nft' + (nftCount + 1)
        } else {
          entityName = 'nft'
          nftCount = nftCount + 1
        }
      }

      // We iterate over the GLTF to find the asset.
      // Builder needs a camel case name of the asset to work correctly
      if (componentType === 'GLTFShape') {
        const assets = await builderApiManager.getAssets([component.data.assetId])
        for (const value of Object.values(assets)) {
          entityName = getUniqueNameForGLTF(gltfNames, camelize(value.name), 1)
        }
      }

      // we add the component to the builder format
      const builderComponent: BuilderComponent = transfromTranslator.transformBuilderComponent({
        id: newId,
        type: componentType,
        data: component.data
      })
      builderComponents[builderComponent.id] = builderComponent
    }

    // We iterate over the name of the entities to asign it in a builder format
    for (const component of Object.values(mappedComponents)) {
      if (component.componentId === fromHumanReadableType('Name')) {
        component.data.builderValue = entityName
      }
    }

    gltfNames.push(entityName)

    // we add the entity to builder format
    const builderEntity: BuilderEntity = {
      id: entityId,
      components: builderComponentsIds,
      disableGizmos: false,
      name: entityName
    }
    entities[builderEntity.id] = builderEntity
  }

  // We create the scene and add it to the manifest
  const sceneState: BuilderScene = {
    id: builderManifest.scene.id,
    entities: entities,
    components: builderComponents,
    assets: builderManifest.scene.assets,
    metrics: builderManifest.scene.metrics,
    limits: builderManifest.scene.limits,
    ground: builderManifest.scene.ground
  }

  builderManifest.scene = sceneState

  // We get all the assetIds from the gltfShapes so we can fetch the corresponded asset
  const idArray: string[] = []
  Object.values(builderManifest.scene.components).forEach((component) => {
    if (component.type === 'GLTFShape') {
      let found = false
      Object.keys(builderManifest.scene.assets).forEach((assets) => {
        if (assets === component.data.assetId) {
          found = true
        }
      })
      if (!found) {
        idArray.push(component.data.assetId)
      }
    }
  })

  // We fetch all the assets that the scene contains since builder needs the assets
  const newAssets = await builderApiManager.getAssets(idArray)
  for (const [key, value] of Object.entries(newAssets)) {
    builderManifest.scene.assets[key] = value
  }

  // We remove unused assets
  const newRecords: Record<string, BuilderAsset> = {}
  for (const [key, value] of Object.entries(builderManifest.scene.assets)) {
    let found = false
    Object.values(builderManifest.scene.components).forEach((component) => {
      if (component.type === 'GLTFShape') {
        if (component.data.assetId === key) found = true
      }
    })

    if (found) {
      newRecords[key] = value
    }
  }

  builderManifest.scene.assets = newRecords

  // This is a special case. The builder needs the ground separated from the rest of the components so we search for it.
  // Unity handles this, so we will find only the same "ground" category. We can safely assume that we can search it and assign
  let groundComponentId: string
  Object.entries(builderManifest.scene.assets).forEach(([assetId, asset]) => {
    if (asset?.category === 'ground') {
      builderManifest.scene.ground.assetId = assetId
      Object.entries(builderManifest.scene.components).forEach(([componentId, component]) => {
        if (component.data.assetId === assetId) {
          builderManifest.scene.ground.componentId = componentId
          groundComponentId = componentId
        }
      })
    }
  })

  // We should disable the gizmos of the floor in the builder
  Object.values(builderManifest.scene.entities).forEach((entity) => {
    Object.values(entity.components).forEach((componentId) => {
      if (componentId === groundComponentId) {
        entity.disableGizmos = true
      }
    })
  })

  return builderManifest
}

export function fromBuildertoStateDefinitionFormat(
  scene: BuilderScene,
  transfromTranslator: SceneTransformTranslator
): SceneStateDefinition {
  const sceneState = new SceneStateDefinition()

  const componentMap = new Map(Object.entries(scene.components))

  for (const entity of Object.values(scene.entities)) {
    const components: Component[] = []
    for (const componentId of entity.components.values()) {
      if (componentMap.has(componentId)) {
        const builderComponent = componentMap.get(componentId)
        const componentData = builderComponent?.data

        // Builder set different the NFTs so we need to create a model that Unity is capable to understand,
        if (!componentData.hasOwnProperty('src') && builderComponent?.type === 'NFTShape') {
          let newAssetId = componentData.url.replaceAll('ethereum://', '')
          const index = newAssetId.indexOf('/')
          const partToRemove = newAssetId.slice(index)
          newAssetId = newAssetId.replaceAll(partToRemove, '')

          const color: UnityColor = {
            r: 0.6404918,
            g: 0.611472,
            b: 0.8584906,
            a: 1
          }
          componentData.src = componentData.url
          componentData.assetId = newAssetId
          componentData.color = color
          componentData.style = 0
        }

        const component: Component = transfromTranslator.transformStateDefinitionComponent({
          componentId: fromHumanReadableType(componentMap.get(componentId)!.type),
          data: componentData
        })
        components.push(component)
      }
    }

    // We need to mantain the builder name of the entity, so we create the equivalent part in biw. We do this so we can mantain the smart-item references
    let componentFound = false

    for (const component of components) {
      if (component.componentId === CLASS_ID.NAME) {
        componentFound = true
        component.data.value = component.data.value
        component.data.builderValue = entity.name
        break
      }
    }
    if (!componentFound) components.push(CreateStatelessNameComponent(entity.name, entity.name, transfromTranslator))

    sceneState.addEntity(entity.id, components)
  }
  return sceneState
}

function CreateStatelessNameComponent(
  name: string,
  builderName: string,
  transfromTranslator: SceneTransformTranslator
): Component {
  const nameComponentData = {
    value: name,
    builderValue: builderName
  }
  const nameComponent: Component = transfromTranslator.transformStateDefinitionComponent({
    componentId: CLASS_ID.NAME,
    data: nameComponentData
  })
  return nameComponent
}

export function fromSerializedStateToStorableFormat(state: SerializedSceneState): StorableSceneState {
  const entities = state.entities.map(({ id, components }) => ({
    id,
    components: components.map(({ type, value }) => ({ type: toHumanReadableType(type), value }))
  }))
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entities
  }
}

export function fromStorableFormatToSerializedState(state: StorableSceneState): SerializedSceneState {
  const entities = state.entities.map(({ id, components }) => ({
    id,
    components: components.map(({ type, value }) => ({ type: fromHumanReadableType(type), value }))
  }))
  return { entities }
}
